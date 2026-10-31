"""Local tests for backend/lambda_function.py.

Run:  pip install -r backend/requirements-dev.txt
      python backend/tests/test_lambda.py

DynamoDB is moto; IoT and Discord are fakes. Nothing touches a real network
or a real AWS account. One test opens a local socket that never answers, to
prove a hung AWS call gives up in under 12 seconds (takes about 8 s).
"""
import http.client
import importlib.util
import json
import logging
import os
import socket
import sys
import threading
import time
import uuid
import base64
from urllib.error import HTTPError, URLError

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

NEW_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lambda_function.py")

os.environ.update(
    AWS_DEFAULT_REGION="us-east-1",
    AWS_ACCESS_KEY_ID="testing",
    AWS_SECRET_ACCESS_KEY="testing",
)
SECRET = "TOKENSECRET"
HOOK = f"https://discord.com/api/webhooks/123/{SECRET}"
ENDPOINT = "abc-ats.iot.us-east-1.amazonaws.com"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"   [{detail}]" if detail and not cond else ""))


class FakeResp:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


class FakeDiscord:
    def __init__(self):
        self.calls, self.behavior = [], None

    def __call__(self, request, timeout=None):
        self.calls.append({
            "url": request.full_url,
            "payload": json.loads(request.data),
            "timeout": timeout,
        })
        if self.behavior:
            return self.behavior()
        return FakeResp(200, json.dumps({"id": "999"}).encode())


class FakeIoT:
    def __init__(self):
        self.publishes, self.fail = [], None

    def publish(self, topic, qos, payload):
        if self.fail:
            raise self.fail
        self.publishes.append({"topic": topic, "payload": json.loads(payload)})


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Env:
    def __init__(self, path, name, set_env=True):
        self.path, self.name, self.set_env = path, name, set_env

    def __enter__(self):
        self.mock = mock_aws()
        self.mock.start()
        r = boto3.resource("dynamodb", region_name="us-east-1")
        r.create_table(
            TableName="ChatbotMessages",
            KeySchema=[{"AttributeName": "message_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "message_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        self.ddb = r.Table("ChatbotMessages")
        os.environ["IOT_ENDPOINT"] = ENDPOINT
        os.environ["DISCORD_WEBHOOK_URL"] = HOOK
        self.mod = load(self.path, self.name)
        self.discord, self.iot = FakeDiscord(), FakeIoT()
        self.iot_boom = None
        self.mod.urlopen = self.discord
        self.mod.get_iot_client = lambda endpoint: self._iot()
        self.log = ListHandler()
        self.log.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        logging.getLogger().addHandler(self.log)
        return self

    def _iot(self):
        if self.iot_boom:
            raise self.iot_boom
        return self.iot

    def call(self, event):
        return self.mod.lambda_handler(event, None)

    def items(self):
        return self.ddb.scan()["Items"]

    def __exit__(self, *a):
        logging.getLogger().removeHandler(self.log)
        self.mock.stop()
        return False


def api_event(body=None, sub="user-1", raw=None, b64=False):
    ev = {
        "version": "2.0",
        "routeKey": "POST /send",
        "isBase64Encoded": b64,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "client_id": "c"}}}},
    }
    if raw is not None:
        ev["body"] = raw
    elif body is not None:
        ev["body"] = json.dumps(body)
    return ev


def body_of(resp):
    return json.loads(resp["body"])


def secret_leaked(env):
    return any(SECRET in line for line in env.log.lines)


# ------------------------------------------------------------------ new Lambda
def suite_new():
    print("=== backend/lambda_function.py ===")
    P = NEW_PATH

    with Env(P, "new1") as e:
        r = e.call(api_event({"message": "  hello team  "}))
        b = body_of(r)
        item = e.items()[0]
        check("happy path: 200 + contract fields", r["statusCode"] == 200 and all(
            k in b for k in ("status", "message_id", "timestamp", "iot_status", "delivery_status", "database_synced")
        ) and b["status"] == "STORED" and b["iot_status"] == "PUBLISHED" and b["delivery_status"] == "SENT" and b["database_synced"] is True, b)
        check("message trimmed, DynamoDB final state correct", item["message"] == "hello team" and item["iot_status"] == "PUBLISHED" and item["delivery_status"] == "SENT" and item["discord_message_id"] == "999", item)
        check("caller's Cognito sub stored", item.get("user_sub") == "user-1")
        check("IoT payload has message_id and no user_sub", e.iot.publishes[0]["payload"]["message_id"] == b["message_id"] and "user_sub" not in e.iot.publishes[0]["payload"] and e.iot.publishes[0]["topic"] == "chatbot-trigger/events")
        p = e.discord.calls[0]
        check("Discord: allowed_mentions blocks pings, wait=true, 5s timeout", p["payload"]["allowed_mentions"] == {"parse": []} and p["url"].endswith("?wait=true") and p["timeout"] == 5)
        check("webhook token not in logs", not secret_leaked(e))

    with Env(P, "new2") as e:
        r = e.call({"message": "direct"})
        check("direct invoke works, no user_sub", r["statusCode"] == 200 and "user_sub" not in e.items()[0])

    with Env(P, "new3") as e:
        cases = {
            "empty": api_event({"message": ""}),
            "whitespace": api_event({"message": "   "}),
            "501 chars": api_event({"message": "x" * 501}),
            "number": api_event({"message": 5}),
            "null": api_event({"message": None}),
            "list body": api_event(raw="[1,2]"),
            "malformed JSON": api_event(raw="{bad"),
            "no body": api_event(),
            "request_id junk": api_event({"message": "hi", "request_id": "abc"}),
            "request_id int": api_event({"message": "hi", "request_id": 123}),
            "bad base64": api_event(raw="%%%not-base64%%%", b64=True),
        }
        bad = []
        for name, ev in cases.items():
            r = e.call(ev)
            if r["statusCode"] != 400:
                bad.append((name, r["statusCode"]))
        check("11 invalid requests all -> 400", not bad, bad)
        check("invalid requests wrote/sent nothing", not e.items() and not e.discord.calls and not e.iot.publishes)
        r = e.call(api_event(raw="{bad"))
        check("malformed JSON error has no parser internals", body_of(r)["message"] == "Request body must be valid JSON", body_of(r))
        r = e.call(api_event({"message": "x" * 500}))
        check("exactly 500 chars accepted", r["statusCode"] == 200)
        raw = base64.b64encode(json.dumps({"message": "b64 ok"}).encode()).decode()
        r = e.call(api_event(raw=raw, b64=True))
        check("base64-encoded body accepted", r["statusCode"] == 200)

    with Env(P, "new4") as e:
        os.environ["DISCORD_WEBHOOK_URL"] = ""
        r = e.call(api_event({"message": "hi"}))
        check("missing webhook env -> 500, nothing stored", r["statusCode"] == 500 and not e.items())
        os.environ["DISCORD_WEBHOOK_URL"] = HOOK

    with Env(P, "new5") as e:
        def boom(**k):
            raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}}, "PutItem")
        e.mod.table.put_item = boom
        r = e.call(api_event({"message": "hi"}))
        check("DynamoDB save fails -> 500, no IoT, no Discord", r["statusCode"] == 500 and not e.discord.calls and not e.iot.publishes)

    with Env(P, "new6") as e:
        e.iot.fail = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "x"}}, "Publish")
        r = e.call(api_event({"message": "hi"}))
        item = e.items()[0]
        check("IoT ClientError -> 502, Discord still sent, DB says FAILED/SENT", r["statusCode"] == 502 and len(e.discord.calls) == 1 and item["iot_status"] == "FAILED" and item["delivery_status"] == "SENT")

    with Env(P, "new7") as e:
        e.iot_boom = ValueError("Invalid endpoint: https://https://x")
        r = e.call(api_event({"message": "hi"}))
        item = e.items()[0]
        check("bad IOT_ENDPOINT (ValueError) -> 502, Discord still sent, DB updated", r["statusCode"] == 502 and len(e.discord.calls) == 1 and item["iot_status"] == "FAILED" and item["delivery_status"] == "SENT")

    discord_failures = {
        "HTTP 429": lambda: (_ for _ in ()).throw(HTTPError(HOOK, 429, "Too Many Requests", {}, None)),
        "URLError": lambda: (_ for _ in ()).throw(URLError("boom " + HOOK)),
        "timeout": lambda: (_ for _ in ()).throw(TimeoutError("timed out " + HOOK)),
        "IncompleteRead": lambda: (_ for _ in ()).throw(http.client.IncompleteRead(b"x")),
        "HTTP 204": lambda: FakeResp(204, b""),
        "non-JSON 200": lambda: FakeResp(200, b"<html>"),
        "200 without id": lambda: FakeResp(200, b"{}"),
        "200 JSON list": lambda: FakeResp(200, b"[1]"),
    }
    bad = []
    leaked = False
    for name, behavior in discord_failures.items():
        with Env(P, "newd") as e:
            e.discord.behavior = behavior
            r = e.call(api_event({"message": "hi"}))
            item = e.items()[0]
            if not (r["statusCode"] == 502 and body_of(r)["delivery_status"] == "FAILED" and item["delivery_status"] == "FAILED" and item["iot_status"] == "PUBLISHED"):
                bad.append(name)
            leaked = leaked or secret_leaked(e)
    check("8 Discord failure modes -> 502, DB FAILED, IoT unaffected", not bad, bad)
    check("webhook token never in logs, even when exceptions contain it", not leaked)

    with Env(P, "new8") as e:
        real_update = e.mod.table.update_item

        def boom(**k):
            raise ClientError({"Error": {"Code": "InternalServerError", "Message": "x"}}, "UpdateItem")
        e.mod.table.update_item = boom
        r = e.call(api_event({"message": "hi"}))
        b = body_of(r)
        check("DB status update fails -> 502, database_synced false, both sends done", r["statusCode"] == 502 and b["database_synced"] is False and len(e.discord.calls) == 1 and len(e.iot.publishes) == 1)

    bad_hooks = [
        "http://discord.com/api/webhooks/1/x",
        "https://discord.com.evil.com/api/webhooks/1/x",
        "https://discord.com@evil.com/api/webhooks/1/x",
        "https://evil.com/api/webhooks/1/x",
        "https://discord.com/other/1/x",
    ]
    bad = []
    for h in bad_hooks:
        with Env(P, "newh") as e:
            os.environ["DISCORD_WEBHOOK_URL"] = h
            r = e.call(api_event({"message": "hi"}))
            if e.discord.calls or r["statusCode"] != 502:
                bad.append(h)
            os.environ["DISCORD_WEBHOOK_URL"] = HOOK
    check("5 look-alike webhook URLs rejected, never contacted", not bad, bad)

    with Env(P, "new9") as e:
        evil = "@everyone @here <@123456>\n**Message ID:** `fake-id`"
        r = e.call(api_event({"message": evil}))
        real = body_of(r)["message_id"]
        c = e.discord.calls[0]["payload"]
        content = c["content"]
        check("mentions neutralised in payload", c["allowed_mentions"] == {"parse": []})
        check("forged 'Message ID' line sits inside the >>> quote, after the real ID", content.index(real) < content.index(">>>") < content.index("fake-id"), content)

    # idempotency
    with Env(P, "new10") as e:
        rid = str(uuid.uuid4())
        r1 = e.call(api_event({"message": "hello", "request_id": rid}, sub="u1"))
        r2 = e.call(api_event({"message": "hello", "request_id": rid}, sub="u1"))
        b2 = body_of(r2)
        check("retry with same request_id: 200, same message_id, duplicate=true", r1["statusCode"] == 200 and r2["statusCode"] == 200 and b2["message_id"] == rid and b2["duplicate"] is True)
        check("retry sent nothing new (1 Discord, 1 IoT, 1 DB item)", len(e.discord.calls) == 1 and len(e.iot.publishes) == 1 and len(e.items()) == 1)
        r = e.call(api_event({"message": "hello", "request_id": rid.upper()}, sub="u1"))
        check("UPPERCASE request_id normalised to the same record", r["statusCode"] == 200 and len(e.discord.calls) == 1)
        r = e.call(api_event({"message": "different", "request_id": rid}, sub="u1"))
        check("same request_id, different message -> 409", r["statusCode"] == 409)
        r = e.call(api_event({"message": "hello", "request_id": rid}, sub="u2"))
        check("same request_id, different user -> 409 (no cross-user replay)", r["statusCode"] == 409 and len(e.discord.calls) == 1)

        rid2 = str(uuid.uuid4())
        e.ddb.put_item(Item={"message_id": rid2, "message": "m", "timestamp": "t", "status": "STORED", "iot_status": "PENDING", "delivery_status": "PENDING", "user_sub": "u1"})
        r = e.call(api_event({"message": "m", "request_id": rid2}, sub="u1"))
        check("retry while first attempt still PENDING -> 202, nothing resent", r["statusCode"] == 202 and body_of(r)["database_synced"] is None and len(e.discord.calls) == 1)

        rid3 = str(uuid.uuid4())
        e.discord.behavior = lambda: (_ for _ in ()).throw(URLError("x"))
        r = e.call(api_event({"message": "f", "request_id": rid3}, sub="u1"))
        n = len(e.discord.calls)
        e.discord.behavior = None
        r2 = e.call(api_event({"message": "f", "request_id": rid3}, sub="u1"))
        check("retry of a failed delivery -> 502 replayed, no automatic resend", r["statusCode"] == 502 and r2["statusCode"] == 502 and body_of(r2)["duplicate"] is True and len(e.discord.calls) == n)

    # real timing against a server that accepts and never answers
    print("\n--- timeout/retry bound (real sockets, no moto) ---")
    mod = load(NEW_PATH, "newt")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(16)
    accepted = []
    held = []

    def accept_loop():
        while True:
            try:
                c, _ = srv.accept()
                accepted.append(1)
                held.append(c)
            except OSError:
                return

    threading.Thread(target=accept_loop, daemon=True).start()
    client = boto3.client("dynamodb", endpoint_url=f"http://127.0.0.1:{srv.getsockname()[1]}", config=mod.AWS_CONFIG)
    t = time.time()
    try:
        client.list_tables()
    except Exception as ex:
        err = type(ex).__name__
    took = time.time() - t
    srv.close()
    print(f"hung AWS endpoint: gave up after {took:.1f}s, {len(accepted)} connection attempt(s), error={err}")
    check("new config: hung AWS call gives up in under 12s with exactly 2 attempts", took < 12 and len(accepted) == 2, f"{took:.1f}s/{len(accepted)}")


suite_new()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
for n, _, d in failed:
    print("FAILED:", n, d)
sys.exit(1 if failed else 0)
