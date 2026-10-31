
import json
import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

TABLE_NAME = "ChatbotMessages"
INDEX_NAME = "user-sub-timestamp-index"

dynamodb = boto3.resource(
    "dynamodb",
    region_name="us-east-1",
    config=Config(
        connect_timeout=2,
        read_timeout=4,
        retries={"mode": "standard", "total_max_attempts": 2}
    )
)

table = dynamodb.Table(TABLE_NAME)


def response(status_code, data):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(data)
    }


def lambda_handler(event, context):
    event = event or {}

    # Get user identity from API Gateway's verified JWT.
    claims = (
        ((event.get("requestContext") or {})
         .get("authorizer") or {})
        .get("jwt") or {}
    ).get("claims") or {}

    user_sub = claims.get("sub")

    if not isinstance(user_sub, str) or not user_sub.strip():
        return response(401, {
            "status": "ERROR",
            "message": "Authentication required"
        })

    try:
        result = table.query(
            IndexName=INDEX_NAME,
            KeyConditionExpression=Key("user_sub").eq(user_sub),
            ScanIndexForward=False,
            Limit=8
        )

        messages = []

        for item in result.get("Items", []):
            messages.append({
                "message_id": item.get("message_id", ""),
                "message": item.get("message", ""),
                "timestamp": item.get("timestamp", ""),
                "status": item.get("status", ""),
                "iot_status": item.get("iot_status", ""),
                "delivery_status": item.get(
                    "delivery_status", ""
                )
            })

        return response(200, {
            "status": "SUCCESS",
            "count": len(messages),
            "messages": messages
        })

    except (ClientError, BotoCoreError) as error:
        print("History query failed:", type(error).__name__)

        return response(502, {
            "status": "ERROR",
            "message": "Unable to load message history"
        })
