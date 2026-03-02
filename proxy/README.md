# fluentify Proxy Setup

This proxy server allows you to use your OpenAI API key securely with the fluentify extension.

## One-Click Setup (Windows)

1.  **Enter your API Key**:
    - Open the `.env` file in this folder.
    - Replace `PASTE_YOUR_OPENAI_KEY_HERE` with your actual OpenAI API key.
2.  **Start the Server**:
    - Double-click `start_proxy.bat`.
    - *Note: The first time you run it, it will automatically install necessary dependencies.*

The proxy will run on `http://localhost:3000`.

## Deployment (Vercel/Railway/Heroku)

1.  Upload the `/proxy` folder to your provider.
2.  Set the `OPENAI_API_KEY` environment variable in your provider's dashboard.
3.  Update the `PROXY_URL` in `background.js` (line 50) to your deployed URL.
4.  Reload the extension.

## How it works

- **Default Mode**: The extension calls `http://localhost:3000/simplify`. No API key is exposed in the extension.
- **User Override**: If a user enters their own key in the extension settings, it skips the proxy and calls OpenAI directly.
