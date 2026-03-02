# fluentify: AI-Powered ESL Learning Extension

fluentify is a sophisticated Chrome extension designed for advanced ESL learners to master complex vocabulary through contextual discovery, AI coaching, and interactive practice.

## Core Features

-   **Contextual Discovery**: Automatically highlights complex words on any webpage.
-   **AI Coach**: Receives personalized, structured analytical reports on your progress, categorized by weakness areas.
-   **Multilingual Support**: Get coaching advice in English, Chinese, French, Spanish, Japanese, Korean, or German.
-   **Interactive Tooltips**: Hover over sophisticated terms in the AI report for specialized tips and definitions.
-   **Sentence Practice**: Practice difficult words with AI-generated organic sentences.
-   **Proficiency Tracking**: A built-in proficiency vector tracks your mastery of every discovered word.

## Project Structure

-   `manifest.json`: Extension configuration.
-   `background.js`: Service worker handling AI logic, data management, and storage.
-   `content.js`: Content script for page analysis and highlighting.
-   `popup/`: The main extension UI (Home, Lessons Learned, Settings).
-   `proxy/`: Express.js server for handling API requests and bypassing CORS.

## Dependencies

- **Chrome Extension**: Vanilla JavaScript (no external dependencies).
- **Proxy Server**: Node.js, Express, dotenv, node-fetch.

## Installation & Setup

> [!TIP]
> For the ultimate step-by-step guide with usage tips, see **[SETUP.md](SETUP.md)**.

### 1. Chrome Extension
1.  Clone this repository to your local machine.
2.  Open Google Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** (top right corner).
4.  Click **Load unpacked** and select the root folder of this project (`Deep-Learning-Week`).

### 2. Proxy Server (Required for AI Features)
The proxy server handles AI simplification and coaching requests.
1.  Navigate to the `proxy` folder.
2.  Create a `.env` file and add your OpenAI API key:
    ```env
    OPENAI_API_KEY=your_key_here
    ```
3.  Install dependencies:
    ```bash
    npm install
    ```
4.  Start the server:
    ```bash
    node server.js
    ```
    *(Alternatively, use `start_proxy.bat` on Windows)*.

## Usage Tips

-   **API Key**: While you can use the proxy server, you can also insert your OpenAI API key **directly into the extension**. Open the extension, go to the **Home** tab, click **Settings**, and paste your key into the OpenAI Key field.
-   **Discovery**: Hover over any highlighted word to see its definition. Right-click any non-highlighted word and select "Highlight with fluentify" to add it to your list.
-   **Lessons Learned**: Visit the "Lessons Learned" tab to see your AI Coaching report and full vocabulary list.
