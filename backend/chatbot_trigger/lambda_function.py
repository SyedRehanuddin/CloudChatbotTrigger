import base64
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

TABLE_NAME = "ChatbotMessages"
IOT_TOPIC = "chatbot-trigger/events"
PROJECT = "Cloud Chatbot Trigger"
MAX_MESSAGE = 500
DISCORD_TIMEOUT = 5

# Short timeouts and one retry, so a slow AWS call cannot push the request
# past API Gateway's 30 s limit (boto3 defaults: 60 s timeouts, up to 10 DynamoDB attempts).
AWS_CONFIG = Config(
    connect_timeout=2,
    read_timeout=4,
    retries={"total_max_attempts": 2, "mode": "standard"},
)

dynamodb = boto3.resource("dynamodb", config=AWS_CONFIG)
table = dynamodb.Table(TABLE_NAME)

_iot_clients = {}


def get_iot_client(endpoint):
    client = _iot_clients.get(endpoint)
    if client is None:
        client = boto3.client(
            "iot-data",
            endpoint_url=f"https://{endpoint}",
            config=AWS_CONFIG,
        )
        _iot_clients[endpoint] = client
    return client


class BadRequest(ValueError):
    pass


def make_response(status_code, data):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(data),
    }


def parse_request(event):
    """Return (message, message_id). message_id is the client's request_id if given."""
    if not isinstance(event, dict):
        raise BadRequest("Invalid request")

    body = event.get("body", event)

    if isinstance(body, str):
        try:
            if event.get("isBase64Encoded"):
                body = base64.b64decode(body).decode("utf-8")
            body = json.loads(body)
        except ValueError:
            raise BadRequest("Request body must be valid JSON")

    if not isinstance(body, dict):
        raise BadRequest("Invalid request body")

    message = body.get("message", "")
    if not isinstance(message, str) or not message.strip():
        raise BadRequest("Message cannot be empty")

    message = message.strip()
    if len(message) > MAX_MESSAGE:
        raise BadRequest(f"Message must be {MAX_MESSAGE} characters or less")

    request_id = body.get("request_id")
    if request_id is None:
        message_id = str(uuid.uuid4())
    else:
        try:
            if not isinstance(request_id, str):
                raise ValueError
            message_id = str(uuid.UUID(request_id))
        except ValueError:
            raise BadRequest("request_id must be a UUID")

    return message, message_id


def get_user_sub(event):
    """Cognito user id from the JWT authorizer (None for direct invocations)."""
    try:
        sub = event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
    except (KeyError, TypeError):
        return None
    return sub if isinstance(sub, str) else None


def send_to_discord(webhook_url, message, message_id):
    parsed = urlsplit(webhook_url)

    if (
        parsed.scheme != "https"
        or parsed.hostname != "discord.com"
        or not parsed.path.startswith("/api/webhooks/")
    ):
        logging.warning("Invalid Discord webhook configuration")
        return "FAILED", None

    separator = "&" if "?" in webhook_url else "?"
    url = webhook_url + separator + "wait=true"

    # The user's text goes last, inside a ">>>" block quote that runs to the end
    # of the message, so it cannot forge the ID line above it.
    payload = {
        "content": (
            f"**{PROJECT}** · ID `{message_id}`\n"
            f">>> {message}"
        ),
        "allowed_mentions": {"parse": []},
    }

    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "CloudChatbotTrigger/1.0",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=DISCORD_TIMEOUT) as response:
            if response.status != 200:
                return "FAILED", None

            result = json.loads(response.read().decode("utf-8"))
            discord_id = result.get("id") if isinstance(result, dict) else None

            if not discord_id:
                return "FAILED", None

            return "SENT", discord_id

    except HTTPError as error:
        logging.warning("Discord returned HTTP %s", error.code)
    except Exception as error:
        # Never log str(error): keep the webhook URL out of the logs.
        logging.warning("Discord request failed: %s", type(error).__name__)

    return "FAILED", None


def body_from_item(item, database_synced, duplicate):
    return {
        "status": "STORED",
        "message_id": item["message_id"],
        "message": item["message"],
        "timestamp": item["timestamp"],
        "iot_status": item["iot_status"],
        "iot_topic": IOT_TOPIC,
        "delivery_status": item["delivery_status"],
        "discord_message_id": item.get("discord_message_id"),
        "database_synced": database_synced,
        "project": PROJECT,
        "duplicate": duplicate,
    }


def replay_existing(message_id, message, user_sub):
    """Same request_id sent again (retry): report the stored result, send nothing."""
    try:
        existing = table.get_item(
            Key={"message_id": message_id}, ConsistentRead=True
        ).get("Item")
    except (ClientError, BotoCoreError):
        logging.exception("DynamoDB read failed")
        return make_response(500, {
            "status": "ERROR",
            "message": "Unable to check earlier request",
        })

    if (
        not existing
        or existing.get("message") != message
        or existing.get("user_sub") != user_sub
    ):
        return make_response(409, {
            "status": "ERROR",
            "message": "request_id was already used for a different message",
        })

    states = (existing["iot_status"], existing["delivery_status"])

    if "PENDING" in states:
        # The first attempt may still be running (client timed out early).
        return make_response(202, body_from_item(existing, None, True))

    ok = states == ("PUBLISHED", "SENT")
    return make_response(200 if ok else 502, body_from_item(existing, True, True))


def lambda_handler(event, context):
    # 1. Validate the request
    try:
        message, message_id = parse_request(event)
    except BadRequest as error:
        return make_response(400, {"status": "ERROR", "message": str(error)})

    user_sub = get_user_sub(event)

    # 2. Read environment settings
    endpoint = os.environ.get("IOT_ENDPOINT", "").strip()
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()

    if not endpoint or not webhook_url:
        return make_response(500, {
            "status": "ERROR",
            "message": "Missing AWS IoT or Discord configuration",
        })

    timestamp = datetime.now(timezone.utc).isoformat()

    # 3. Save the message first (a repeated request_id is caught here)
    item = {
        "message_id": message_id,
        "message": message,
        "timestamp": timestamp,
        "status": "STORED",
        "iot_status": "PENDING",
        "delivery_status": "PENDING",
        "project": PROJECT,
    }
    if user_sub:
        item["user_sub"] = user_sub

    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(message_id)",
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return replay_existing(message_id, message, user_sub)
        logging.exception("DynamoDB save failed")
        return make_response(500, {"status": "ERROR", "message": "Unable to save message"})
    except BotoCoreError:
        logging.exception("DynamoDB save failed")
        return make_response(500, {"status": "ERROR", "message": "Unable to save message"})

    # 4. Publish to AWS IoT Core (isolated: a failure here must not stop Discord)
    iot_status = "FAILED"

    mqtt_payload = {
        "message_id": message_id,
        "message": message,
        "timestamp": timestamp,
        "status": "PUBLISHED",
        "project": PROJECT,
    }

    try:
        get_iot_client(endpoint).publish(
            topic=IOT_TOPIC,
            qos=0,
            payload=json.dumps(mqtt_payload).encode("utf-8"),
        )
        iot_status = "PUBLISHED"
    except Exception as error:
        logging.warning("AWS IoT publish failed: %s", type(error).__name__)

    # 5. Send to Discord
    delivery_status, discord_message_id = send_to_discord(
        webhook_url, message, message_id
    )

    # 6. Record the results
    database_synced = False

    try:
        expression = "SET iot_status = :iot, delivery_status = :delivery"
        values = {":iot": iot_status, ":delivery": delivery_status}

        if discord_message_id:
            expression += ", discord_message_id = :discord_id"
            values[":discord_id"] = discord_message_id

        table.update_item(
            Key={"message_id": message_id},
            UpdateExpression=expression,
            ExpressionAttributeValues=values,
        )
        database_synced = True
    except (ClientError, BotoCoreError):
        logging.exception("DynamoDB status update failed")

    # 7. Return the real results
    success = (
        iot_status == "PUBLISHED"
        and delivery_status == "SENT"
        and database_synced
    )

    result = body_from_item(
        {
            "message_id": message_id,
            "message": message,
            "timestamp": timestamp,
            "iot_status": iot_status,
            "delivery_status": delivery_status,
            "discord_message_id": discord_message_id,
        },
        database_synced,
        False,
    )
    return make_response(200 if success else 502, result)
