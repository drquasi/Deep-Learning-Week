document.addEventListener('DOMContentLoaded', async () => {
    const masterToggle = document.getElementById('master-toggle');
    const autoSimplifyToggle = document.getElementById('auto-simplify-toggle');
    const statsSeenEl = document.getElementById('stats-seen');
    const statsMasteredEl = document.getElementById('stats-mastered');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsPanel = document.getElementById('settings-panel');
    const viewInsights = document.getElementById('view-insights');
    const closeInsights = document.getElementById('close-insights');
    const insightsPanel = document.getElementById('insights-panel');
    const insightsLoading = document.getElementById('insights-loading');
    const insightsDisplay = document.getElementById('insights-display');
    const aiInsightText = document.getElementById('ai-insight-text');
    const strugglingContainer = document.getElementById('struggling-words-container');
    const wordList = document.getElementById('word-list');

    // Debug Elements
    const openDebug = document.getElementById('open-debug');
    const closeDebug = document.getElementById('close-debug');
    const debugPanel = document.getElementById('debug-panel');
    const vocabBody = document.getElementById('vocab-body');
    const resetDbBtn = document.getElementById('reset-db');
    const forceDecayBtn = document.getElementById('force-decay');

    // Load saved settings & stats
    const settings = await chrome.storage.local.get(['enabled', 'autoSimplify', 'openaiKey']);
    masterToggle.checked = settings.enabled !== false;
    autoSimplifyToggle.checked = settings.autoSimplify === true;
    if (settings.openaiKey) document.getElementById('openai-key').value = settings.openaiKey;

    // Fetch Real Vocabulary Stats
    async function updateStats() {
        chrome.runtime.sendMessage({ type: 'GET_VOCAB_STATS' }, (stats) => {
            if (stats) {
                statsSeenEl.textContent = stats.total || 0;
                statsMasteredEl.textContent = stats.mastered || 0;
            }
        });
    }
    updateStats();

    // Event Listeners
    settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('visible'));

    document.getElementById('save-key').addEventListener('click', () => {
        const key = document.getElementById('openai-key').value.trim();
        chrome.storage.local.set({ openaiKey: key }, () => {
            const btn = document.getElementById('save-key');
            btn.textContent = 'Saved!';
            setTimeout(() => {
                btn.textContent = 'Save';
                settingsPanel.classList.remove('visible');
            }, 1000);
        });
    });

    masterToggle.addEventListener('change', () => chrome.storage.local.set({ enabled: masterToggle.checked }));
    autoSimplifyToggle.addEventListener('change', () => chrome.storage.local.set({ autoSimplify: autoSimplifyToggle.checked }));

    const simplifyPageBtn = document.getElementById('simplify-page-btn');
    simplifyPageBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'START_SIMPLIFY' }, (res) => {
                // Feedback
                simplifyPageBtn.textContent = '🚀 Simplifying...';
                simplifyPageBtn.style.background = '#4f46e5';
                setTimeout(() => {
                    simplifyPageBtn.textContent = '✨ Simplify This Page';
                    simplifyPageBtn.style.background = 'linear-gradient(135deg, #9333ea 0%, #4f46e5 100%)';
                    window.close(); // Close popup to let user see the page
                }, 1000);
            });
        }
    });

    viewInsights.addEventListener('click', () => {
        insightsPanel.classList.remove('hidden');
        insightsLoading.classList.remove('hidden');
        insightsDisplay.classList.add('hidden');

        chrome.runtime.sendMessage({ type: 'GET_LEARNING_INSIGHTS' }, (data) => {
            insightsLoading.classList.add('hidden');
            insightsDisplay.classList.remove('hidden');

            if (data && data.insight) {
                aiInsightText.textContent = data.insight;
                if (data.words && data.words.length > 0) {
                    strugglingContainer.classList.remove('hidden');
                    wordList.innerHTML = '';
                    data.words.forEach(word => {
                        const li = document.createElement('li');
                        li.textContent = word;
                        wordList.appendChild(li);
                    });
                } else {
                    strugglingContainer.classList.add('hidden');
                }
            } else {
                aiInsightText.textContent = "Could not generate insights. Keep reading to provide more data!";
            }
        });
    });

    closeInsights.addEventListener('click', () => insightsPanel.classList.add('hidden'));

    // Debug Logic
    openDebug.addEventListener('click', () => {
        debugPanel.classList.remove('hidden');
        refreshDebugTable();
    });

    closeDebug.addEventListener('click', () => debugPanel.classList.add('hidden'));

    async function refreshDebugTable() {
        // We'll use a specific message to get all words for debug
        chrome.runtime.sendMessage({ type: 'GET_LEARNING_INSIGHTS' }, (data) => {
            // Re-using the insights handler's word gathering if possible, 
            // but let's just use a more direct way if we want full list.
            // For now, let's assume background has a generic 'GET_ALL_WORDS' handler we should add.
            chrome.runtime.sendMessage({ type: 'DEBUG_GET_ALL_WORDS' }, (words) => {
                vocabBody.innerHTML = '';
                if (words && Array.isArray(words)) {
                    words.sort((a, b) => b.proficiency - a.proficiency).forEach(w => {
                        const tr = document.createElement('tr');
                        tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        tr.innerHTML = `
                            <td style="padding: 6px;">${w.word}</td>
                            <td style="padding: 6px;">${(w.proficiency || 0).toFixed(2)}</td>
                            <td style="padding: 6px;">${(w.stability || 0).toFixed(2)}</td>
                        `;
                        vocabBody.appendChild(tr);
                    });
                }
            });
        });
    }

    resetDbBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset ALL learning data? This cannot be undone.')) {
            chrome.runtime.sendMessage({ type: 'DEBUG_RESET_DB' }, (res) => {
                if (res && res.success) {
                    alert('Database reset successfully.');
                    location.reload();
                }
            });
        }
    });

    forceDecayBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'DEBUG_FORCE_DECAY', days: 7 }, (res) => {
            if (res && res.success) {
                alert(`Decay applied to ${res.count} words. Refresh to see changes.`);
                refreshDebugTable();
            }
        });
    });
});
