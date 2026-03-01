document.addEventListener('DOMContentLoaded', async () => {
    const masterToggle = document.getElementById('master-toggle');
    const levelSelect = document.getElementById('level-select');
    const viewInsights = document.getElementById('view-insights');
    const closeInsights = document.getElementById('close-insights');
    const insightsPanel = document.getElementById('insights-panel');

    const autoSimplifyToggle = document.getElementById('auto-simplify-toggle');
    const wordsScannedEl = document.getElementById('words-scanned');
    const wordsLearnedEl = document.getElementById('words-learned');

    // Load saved settings
    const settings = await chrome.storage.local.get(['enabled', 'level', 'scannedCount', 'learnedCount', 'autoSimplify', 'openaiKey']);

    masterToggle.checked = settings.enabled !== false;
    autoSimplifyToggle.checked = settings.autoSimplify === true; // Opt-in
    if (settings.level) levelSelect.value = settings.level;
    if (settings.openaiKey) document.getElementById('openai-key').value = settings.openaiKey;

    wordsScannedEl.textContent = settings.scannedCount || 0;
    wordsLearnedEl.textContent = settings.learnedCount || 0;

    // Event Listeners
    document.getElementById('save-key').addEventListener('click', () => {
        const key = document.getElementById('openai-key').value.trim();
        chrome.storage.local.set({ openaiKey: key }, () => {
            const btn = document.getElementById('save-key');
            const originalText = btn.textContent;
            btn.textContent = 'Saved!';
            btn.style.background = '#4BB543';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '';
            }, 2000);
        });
    });

    masterToggle.addEventListener('change', () => {
        chrome.storage.local.set({ enabled: masterToggle.checked });
    });

    autoSimplifyToggle.addEventListener('change', () => {
        chrome.storage.local.set({ autoSimplify: autoSimplifyToggle.checked });
    });

    levelSelect.addEventListener('change', () => {
        chrome.storage.local.set({ level: levelSelect.value });
    });

    viewInsights.addEventListener('click', async () => {
        const analytics = await chrome.runtime.sendMessage({ type: 'GET_ANALYTICS' });

        if (analytics) {
            const wordList = document.getElementById('word-list');
            wordList.innerHTML = '';

            if (analytics.strugglingWords.length > 0) {
                analytics.strugglingWords.forEach(word => {
                    const li = document.createElement('li');
                    li.textContent = word.charAt(0).toUpperCase() + word.slice(1);
                    wordList.appendChild(li);
                });
            } else {
                wordList.innerHTML = '<li>Keep reading to gather insights!</li>';
            }

            wordsLearnedEl.textContent = analytics.learnedCount;
        }

        insightsPanel.classList.remove('hidden');
    });

    closeInsights.addEventListener('click', () => {
        insightsPanel.classList.add('hidden');
    });
});
