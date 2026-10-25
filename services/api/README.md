
## Shared watch queue and identity note

The shared watch queue is held in process memory and is lost when the API restarts. Queue suggestions accept YouTube video IDs (the web client also extracts IDs from supported YouTube URLs); queue changes and playback actions are broadcast over the room WebSocket.

Room connection identity is currently based on opaque IDs returned by the create/join HTTP endpoints and values in the WebSocket URL. The backend derives the connected username and role for each accepted connection and never trusts names or roles in reaction, typing, chat, or queue payloads. However, the opaque participant IDs are not backed by a signed or otherwise verified session token. This is not a production-secure authentication mechanism: a determined client may attempt to claim an unconnected participant ID. Deployments requiring strong identity guarantees should add verified session tokens and authenticate the WebSocket handshake.
