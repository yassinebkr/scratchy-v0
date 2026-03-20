// Scratchy — OpenClaw WebSocket Gateway Client
//
// Connects to the OpenClaw gateway via WebSocket, performs the protocol
// handshake, then maintains a persistent connection. Incoming messages
// are emitted as Tauri events to the frontend. Outgoing messages are
// sent through a shared writer protected by Arc<Mutex>.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use futures_util::stream::SplitSink;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::MaybeTlsStream;
use tokio::net::TcpStream;

// --- Protocol Frames ---

#[derive(Serialize)]
struct RequestFrame {
    #[serde(rename = "type")]
    frame_type: String,
    id: String,
    method: String,
    params: Value,
}

#[derive(Deserialize, Debug)]
struct ResponseFrame {
    #[serde(rename = "type")]
    frame_type: String,
    id: Option<String>,
    ok: Option<bool>,
    error: Option<String>,
}

/// Shared WebSocket writer type (thread-safe, async-safe).
pub type WsWriter = Arc<Mutex<SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>>>;


/// Connect to the OpenClaw gateway, perform handshake, and start
/// a background reader loop that emits events to the Tauri frontend.
///
/// Returns the writer half for sending messages later.
pub async fn connect(url: &str, app_handle: tauri::AppHandle) -> Result<WsWriter, String> {
    let (ws_stream, _response) = connect_async(url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;

    println!("[Gateway] Connected to {}", url);

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(Mutex::new(write));

    // Handshake
    let handshake = RequestFrame {
        frame_type: "req".to_string(),
        id: "handshake-1".to_string(),
        method: "connect".to_string(),
        params: serde_json::json!({
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": {
                "id": "Webchat",
                "displayName": "Scratchy",
                "version": "0.1.0",
                "platform": "desktop",
                "mode": "webchat"
            },
            "role": "operator"
        }),
    };

    let handshake_json = serde_json::to_string(&handshake)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;

    write.lock().await
        .send(Message::Text(handshake_json))
        .await
        .map_err(|e| format!("Send failed: {}", e))?;

    println!("[Gateway] Handshake sent");

    if let Some(msg) = read.next().await {
        let msg = msg.map_err(|e| format!("Read failed: {}", e))?;

        if let Message::Text(text) = msg {
            let frame: ResponseFrame = serde_json::from_str(&text)
                .map_err(|e| format!("JSON parse failed: {}", e))?;

            if frame.ok != Some(true) {
                return Err(format!("Handshake rejected: {:?}", frame.error));
            }

            println!("[Gateway] Handshake complete");
        }
    } else {
        return Err("No handshake response received".to_string());
    }

    // Background reader: forward all messages to JS via Tauri events
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    app_handle.emit("gateway-message", &text).ok();
                }
                Ok(Message::Close(_)) => {
                    println!("[Gateway] Connection closed by server");
                    break;
                }
                Err(e) => {
                    println!("[Gateway] Read error: {}", e);
                    break;
                }
                _ => {}
            }
        }
        println!("[Gateway] Reader loop ended");
    });

    Ok(write)
}


/// Send a chat message through the gateway.
pub async fn send_message(writer: &WsWriter, message: &str) -> Result<(), String> {
    let frame = RequestFrame {
        frame_type: "req".to_string(),
        id: format!("msg-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()),
        method: "chat.send".to_string(),
        params: serde_json::json!({ "message": message }),
    };

    let json = serde_json::to_string(&frame)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;

    writer.lock().await
        .send(Message::Text(json))
        .await
        .map_err(|e| format!("Send failed: {}", e))?;

    Ok(())
}
