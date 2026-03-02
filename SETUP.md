# fluentify: Setup & Run Guide

Follow these steps to get fluentify up and running on your local machine.

## Prerequisites
- **Google Chrome** browser.
- **Node.js** (v14 or higher) installed on your system.
- An **OpenAI API Key**.

---

## Step 1: Proxy Server Setup
The proxy server handles AI-powered features like sentence simplification and coaching.

1.  Open your terminal or command prompt.
2.  Navigate to the `proxy` directory:
    ```bash
    cd proxy
    ```
3.  Install the required dependencies:
    ```bash
    npm install
    ```
4.  Configure your API Key:
    - Create a new file named `.env` in the `proxy` folder.
    - Add the following line to the file, replacing `your_api_key_here` with your actual OpenAI key:
      ```env
      OPENAI_API_KEY=your_api_key_here
      ```
5.  Start the server:
    ```bash
    node server.js
    ```
    *Note: On Windows, you can simply double-click `start_proxy.bat`.*

---

## Step 2: Install the Chrome Extension
1.  Open Chrome and go to the extensions page by entering `chrome://extensions/` in the address bar.
2.  In the top-right corner, toggle **Developer mode** to ON.
3.  Click the **Load unpacked** button.
4.  In the file picker, select the main `Deep-Learning-Week` folder (the root folder of this project).
5.  The fluentify icon should now appear in your extension toolbar.

---

## Step 3: Usage & Configuration

### Direct API Key Entry (Alternative)
If you prefer not to use the proxy server's `.env` file, you can enter your key directly into the extension:
1.  Click the fluentify icon.
2.  Go to the **Home** tab if not already there.
3.  Click the **Settings** gear icon.
4.  Paste your OpenAI key into the field and click **Save**.

### How to use
1.  **Read any article**: Navigate to a news site or blog. fluentify will automatically highlight complex vocabulary.
2.  **Discover words**: Hover over highlighted words to see definitions and AI-simplified context.
3.  **Manual Highlight**: See a word you don't know that isn't highlighted? **Right-click** it and select "Highlight with fluentify".
4.  **Lessons Learned**: Click the extension icon and go to the **Lessons Learned** tab.
    - Use the **AI Coach** sub-tab for a deep analysis of your progress.
    - Use the **My Vocabulary** sub-tab to see every word you've found.
    - Use the **Language Dropdown** to get advice in your native language!
