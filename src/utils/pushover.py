import requests
import secrets

def send_notification(message: str, options: dict = {}):
    print(f"Sending notification to Pushover: {message}")
    response = requests.post("https://api.pushover.net/1/messages.json", data={
        "token": secrets.PUSHOVER_TOKEN,
        "user": secrets.PUSHOVER_USER,
        "message": message,
        **options,
    })
    if response.json().get("status") != 1:
        raise Exception(f"Failed to send notification to Pushover: {response.json().get('status')}")
    print("Sent notification to Pushover")
