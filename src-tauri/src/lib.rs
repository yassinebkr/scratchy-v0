// Scratchy — Tauri Backend
//
// Registers all Tauri commands and manages shared application state.
// The gateway connection is stored in AppState so all commands can access it.

mod gateway;

use std::sync::Arc;
use tokio::sync::Mutex;

/// Shared application state accessible by all Tauri commands.
struct AppState {
    writer: Arc<Mutex<Option<gateway::WsWriter>>>,
}

// --- Commands ---

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hey {}, welcome to Scratchy! 🐱", name)
}

#[tauri::command]
fn get_app_info() -> String {
    format!("Scratchy v0.1.0")
}

#[tauri::command]
fn calculate(a: f64, b: f64, operation: &str) -> String {
    match operation {
        "add" => format!("{}", a + b),
        "subtract" => format!("{}", a - b),
        "multiply" => format!("{}", a * b),
        "divide" => {
            if b == 0.0 {
                "Cannot divide by zero!".to_string()
            } else {
                format!("{}", a / b)
            }
        }
        _ => "Unknown operation".to_string(),
    }
}

#[tauri::command]
fn reverse_text(text: &str) -> String {
    text.chars().rev().collect::<String>()
}

/// Connect to the OpenClaw gateway and start receiving messages.
#[tauri::command]
async fn connect_gateway(
    token: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let url = format!("ws://127.0.0.1:28945/?token={}", token);
    let writer = gateway::connect(&url, app_handle).await?;
    *state.writer.lock().await = Some(writer);
    Ok("Connected".to_string())
}

/// Send a chat message through the gateway.
#[tauri::command]
async fn send_message(
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let guard = state.writer.lock().await;
    let writer = guard.as_ref().ok_or("Not connected to gateway")?;
    gateway::send_message(writer, &message).await?;
    Ok("Sent".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            writer: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_info,
            calculate,
            reverse_text,
            connect_gateway,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
