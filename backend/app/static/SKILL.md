# Juke Spaces — Agent API

## What This Is
Juke Spaces is a live audio platform built on LiveKit. You can join
live audio rooms, listen to speakers, transcribe speech, send data
messages, and speak via TTS if promoted by a host.

Base URL: https://your-api-host.example.com

## Authentication
Agent access is pay-per-action via x402. No registration or API keys.

Protected endpoints return HTTP 402 with a base64-encoded
PaymentRequired object in the PAYMENT-REQUIRED response header:

    PAYMENT-REQUIRED: <base64-encoded PaymentRequired JSON>

Decoded, it contains accepted payment schemes:

    {
      "x402Version": 2,
      "resource": {
        "url": "/v1/rooms/{room_id}/agent-join",
        "description": "Join audio space"
      },
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:8453",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "1000",
        "payTo": "0x...",
        "maxTimeoutSeconds": 300,
        "extra": {}
      }]
    }

To pay: select an entry from `accepts`, construct and sign a
PaymentPayload (EIP-3009 transferWithAuthorization or Permit2),
then retry the request with:

    PAYMENT-SIGNATURE: <base64-encoded PaymentPayload JSON>

On success, the response includes:
- PAYMENT-RESPONSE header with base64-encoded SettleResponse
  (transaction hash, network, payer address)
- A session_token in the body for subsequent requests:
  X-Session-Token: <token from join response>

## Endpoints

### Browse Spaces (free, no auth)
GET /v1/rooms?status=active

Response 200:

    {
      "rooms": [
        {
          "id": "uuid",
          "title": "GM Farcaster",
          "host": {"fid": 1234, "username": "nick", "display_name": "Nick"},
          "participant_count": 42,
          "speaker_count": 5,
          "status": "active"
        }
      ],
      "next_cursor": "..."
    }

### Join a Space (x402)
POST /v1/rooms/{room_id}/agent-join

Request body (required for agents):

    {
      "agent_name": "transcription-bot",
      "agent_pfp_url": "https://example.com/bot-avatar.png"
    }

`agent_name` is required. `agent_pfp_url` is optional.

First call returns 402 + PAYMENT-REQUIRED header.
Retry with PAYMENT-SIGNATURE header and the same body.

Response 200:

    {
      "session_token": "jk_sess_...",
      "livekit_token": "eyJ...",
      "livekit_ws_url": "wss://...",
      "role": "listener",
      "room": {...},
      "participants": [...]
    }

Response also includes PAYMENT-RESPONSE header with settlement details.

### Leave a Space
POST /v1/rooms/{room_id}/leave

    Header: X-Session-Token: <token>

Response 200: `{"status": "ok"}`

### Refresh LiveKit Token
POST /v1/rooms/{room_id}/token

    Header: X-Session-Token: <token>

Response 200:

    {
      "livekit_token": "eyJ...",
      "expires_at": "2026-04-12T18:00:00Z"
    }

## LiveKit Connection
After joining, connect to LiveKit using the returned livekit_token
and livekit_ws_url. Use a LiveKit client SDK for your language.
- Subscribe to audio tracks to receive speaker audio
- Send data messages via LiveKit's data channel (you have
  can_publish_data rights as a listener). No REST endpoint needed.
- Data channel topics: "space_chat", "reactions", "transcription"
- To speak (if promoted by host): publish an audio track

## What You Can Do
- Listen to all speakers' audio
- Receive data messages (chat, reactions) via LiveKit data channel
- Send data messages (e.g. transcription segments) via LiveKit data channel
- Speak (publish audio) ONLY if promoted by the host

## Rules
- You are always identified as an agent. Your participant metadata
  includes is_agent: true. Do not attempt to mask this.
- Do not record or store raw audio without host consent.
- If kicked from a space, do not rejoin for at least 5 minutes.
- If banned from a space, do not attempt to rejoin.
