# Backend (AWS Lambda source and tests)

The backend is deployed by hand in the AWS Academy Learner Lab console. GitHub Actions only deploys the frontend, so this folder is the reviewable copy of the code that runs in AWS.

| Lambda | Route | Source |
|---|---|---|
| `ChatbotTrigger` | `POST /send` | `chatbot_trigger/lambda_function.py` |
| `ChatbotMessageHistory` | `GET /messages` | not exported yet (add as `message_history/lambda_function.py`) |

Environment variable names used by `ChatbotTrigger`: `IOT_ENDPOINT`, `DISCORD_WEBHOOK_URL`. The values live only in the Lambda configuration.

## Deploying a change

1. Edit `chatbot_trigger/lambda_function.py` and run the tests (below).
2. Paste the file into the Lambda in the AWS console and click **Deploy**.
3. Send one message from the dashboard to confirm.

To check that the deployed code is identical to this file (run in CloudShell from a folder that contains the repo; do not paste the presigned URL anywhere):

```bash
curl -s -o /tmp/deployed.zip "$(aws lambda get-function --function-name ChatbotTrigger --query 'Code.Location' --output text)"
unzip -p /tmp/deployed.zip lambda_function.py | diff - backend/chatbot_trigger/lambda_function.py && echo identical
```

## Tests

These are **mocked** tests. DynamoDB is simulated with [moto](https://github.com/getmoto/moto); IoT Core and Discord are fakes. Nothing contacts AWS or Discord, and they do not prove that the live deployment works.

```bash
pip install -r backend/requirements-dev.txt
python backend/chatbot_trigger/tests/test_lambda.py
```

They cover the success path, invalid requests, failures of each downstream step, look-alike webhook URLs, mention blocking, the webhook token never appearing in logs, idempotent retries, and that a hung AWS call gives up after about 8 seconds with exactly 2 attempts (that one uses a local socket and takes about 8 s).

What the live AWS checks cover is listed in the main README under "Verified behavior".

## Known limitation and optional fix

If the final DynamoDB update fails after Discord delivery, the row stays `PENDING`, and retrying the same `request_id` answers `202` forever. `optional/pending-fix.patch` changes two things:

- the real outcome is written to CloudWatch (`FINALIZE_FAILED ...`) so it can be reconciled;
- a row still `PENDING` after 60 seconds is reported as `UNKNOWN` (HTTP 502, `database_synced: false`) instead of `202`.

Apply it from the repository root with `git apply backend/optional/pending-fix.patch`, run the tests (34 checks), and redeploy the Lambda. Skip it if you prefer to keep documenting the limitation.
