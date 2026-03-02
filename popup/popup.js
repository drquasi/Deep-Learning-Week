document.addEventListener('DOMContentLoaded', async () => {
    const masterToggle = document.getElementById('master-toggle');
    const autoSimplifyToggle = document.getElementById('auto-simplify-toggle');
    const statsSeenEl = document.getElementById('stats-seen');
    const statsMasteredEl = document.getElementById('stats-mastered');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsPanel = document.getElementById('settings-panel');

    // Tab Elements
    const tabHome = document.getElementById('tab-home');
    const tabLessons = document.getElementById('tab-lessons');
    const homeView = document.getElementById('home-view');
    const lessonsView = document.getElementById('lessons-view');

    const insightsLoading = document.getElementById('insights-loading');
    const insightsDisplay = document.getElementById('insights-display');
    const aiInsightText = document.getElementById('ai-insight-text');
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

    function renderInsightWithTooltips(text, container) {
        if (!text) return;

        // Handle Markdown-lite
        let html = text
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n\n/g, '</p><p>');

        // Handle Tooltips
        const tooltipRegex = /\[\[(.*?)\|(.*?)\]\]/g;
        html = html.replace(tooltipRegex, (match, word, tip) => {
            return `<span class="insight-tooltip-target" data-tip="${tip}">${word}</span>`;
        });

        container.innerHTML = `<p>${html}</p>`;
    }

    const refreshCoachBtn = document.getElementById('refresh-coach-btn');
    if (refreshCoachBtn) {
        refreshCoachBtn.onclick = () => {
            refreshCoachBtn.classList.add('spinning');
            loadLessonsLearned();
            setTimeout(() => refreshCoachBtn.classList.remove('spinning'), 1000);
        };
    }

    // Event Listeners
    settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('visible'));

    const languageSelect = document.getElementById('coach-language-select');
    chrome.storage.local.get(['coachLanguage'], (result) => {
        if (result.coachLanguage) languageSelect.value = result.coachLanguage;
    });

    languageSelect.addEventListener('change', () => {
        const lang = languageSelect.value;
        chrome.storage.local.set({ coachLanguage: lang }, () => {
            loadLessonsLearned(true);
        });
    });

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

    // --- LEANING FEATURES (Examples / Practice) ---
    const startQuizBtn = document.getElementById('start-quiz');
    const practicePanel = document.getElementById('practice-panel');
    const closePractice = document.getElementById('close-practice');
    const practiceDisplay = document.getElementById('practice-display');
    const practiceLoading = document.getElementById('practice-loading');
    const practiceSentences = document.getElementById('practice-sentences');
    const quizQuestion = document.getElementById('quiz-question');
    const quizOptions = document.getElementById('quiz-options');
    const quizFeedback = document.getElementById('quiz-feedback');
    const practiceWordTitle = document.getElementById('practice-word-title');

    let currentQuiz = [];
    let currentQuizIdx = 0;


    closePractice.addEventListener('click', () => {
        practicePanel.classList.add('hidden');
        updateStats();
    });

    function showQuizItem(item, isRefresh = false) {
        if (!item) {
            practiceWordTitle.textContent = "Done!";
            practiceDisplay.innerHTML = `
                <div class="insight-text" style="text-align: center; padding: 20px;">
                    <p style="margin-bottom: 16px;">Great job! You've reviewed all your daily examples.</p>
                </div>
            `;
            return;
        }

        // Add Generate More to the end of a single word review
        function showDoneState() {
            const hasNext = currentQuizIdx < currentQuiz.length - 1;
            practiceDisplay.innerHTML = `
                <div style="text-align: center; padding: 20px 0;">
                    <p style="font-size: 14px; color: #10b981; font-weight: 500;">Review Complete!</p>
                    <p style="font-size: 11px; color: var(--text-dim); margin-top: 4px; margin-bottom: 16px;">Proficiency updated.</p>
                    <button id="pop-done-gen-more" class="action-btn primary-btn">Generate 6 More Examples</button>
                    <button id="pop-done-action" class="action-btn secondary-btn" style="margin-top: 8px;">${hasNext ? 'Next Word' : 'Close'}</button>
                </div>
            `;
            practiceDisplay.querySelector('#pop-done-gen-more').onclick = () => {
                practiceDisplay.classList.add('hidden');
                practiceLoading.classList.remove('hidden');
                chrome.runtime.sendMessage({ type: 'GET_PRACTICE_CONTENT', word: item.word, forceRefresh: true }, (newContent) => {
                    if (newContent) showQuizItem(newContent, true);
                });
            };
            practiceDisplay.querySelector('#pop-done-action').onclick = () => {
                if (hasNext) {
                    currentQuizIdx++;
                    showQuizItem(currentQuiz[currentQuizIdx]);
                } else {
                    practicePanel.classList.add('hidden');
                    updateStats();
                }
            };
        }

        practiceWordTitle.textContent = `Review: ${item.word}`;
        practiceDisplay.classList.remove('hidden');
        practiceLoading.classList.add('hidden');
        quizFeedback.classList.add('hidden');

        let sentenceIndex = 0;
        const totalSentences = item.sentences || [];

        function renderCard() {
            if (sentenceIndex >= totalSentences.length || (sentenceIndex >= 3 && totalSentences.length <= 3)) {
                if (totalSentences.length > 3 && sentenceIndex === 3) {
                    renderExtraBatchPrompt();
                    return;
                }

                showDoneState();
                return;
            }

            const sentence = totalSentences[sentenceIndex];
            practiceSentences.innerHTML = `
                <li style="list-style: none; margin: 0; padding: 12px; border-left: 3px solid #3b82f6; background: rgba(59, 130, 246, 0.1); border-radius: 4px; font-size: 13px; line-height: 1.5;">${sentence}</li>
            `;

            quizQuestion.parentElement.classList.add('hidden');
            quizOptions.innerHTML = `
                <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <button id="pop-card-understand" class="action-btn primary-btn" style="flex: 1; font-size: 11px;">I Understand</button>
                    <button id="pop-card-difficult" class="action-btn secondary-btn" style="flex: 1; font-size: 11px;">Difficult</button>
                </div>
                <div style="margin-top: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 10px; color: #9ca3af;">Sample ${sentenceIndex + 1} of ${Math.min(totalSentences.length, 3)}</span>
                    <button id="pop-refresh" class="icon-btn" title="Refetch natural sentences" style="color: var(--accent); padding: 4px;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                    </button>
                </div>
            `;

            quizOptions.querySelector('#pop-card-understand').onclick = () => {
                chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', word: item.word, interaction: 'practice_viewed' });
                sentenceIndex++;
                renderCard();
            };

            quizOptions.querySelector('#pop-card-difficult').onclick = () => {
                chrome.runtime.sendMessage({ type: 'LOG_MISUNDERSTOOD', word: item.word, sentence: sentence });
                sentenceIndex++;
                renderCard();
            };

            quizOptions.querySelector('#pop-refresh').onclick = () => {
                practiceDisplay.classList.add('hidden');
                practiceLoading.classList.remove('hidden');
                chrome.runtime.sendMessage({ type: 'GET_PRACTICE_CONTENT', word: item.word, forceRefresh: true }, (newContent) => {
                    if (newContent) showQuizItem(newContent, true);
                });
            };
        }

        function renderExtraBatchPrompt() {
            practiceSentences.innerHTML = `
                <li style="list-style: none; margin: 0; padding: 12px; text-align: center; font-size: 13px; color: var(--text-dim);">You've seen 6 examples for "${item.word}".</li>
            `;
            quizOptions.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                    <button id="pop-load-more" class="action-btn primary-btn">Show 3 More Examples</button>
                    <button id="pop-gen-new" class="action-btn secondary-btn" style="border-style: dashed;">Generate 6 New Examples</button>
                    <button id="pop-next-word" class="action-btn secondary-btn">Next Word</button>
                </div>
            `;

            const loadMoreBtn = quizOptions.querySelector('#pop-load-more');
            if (totalSentences.length > 3) {
                loadMoreBtn.onclick = () => {
                    const remaining = totalSentences.slice(3, 6);
                    totalSentences.splice(0, totalSentences.length, ...remaining);
                    sentenceIndex = 0;
                    renderCard();
                };
            } else {
                loadMoreBtn.classList.add('hidden');
            }

            quizOptions.querySelector('#pop-gen-new').onclick = () => {
                practiceDisplay.classList.add('hidden');
                practiceLoading.classList.remove('hidden');
                chrome.runtime.sendMessage({ type: 'GET_PRACTICE_CONTENT', word: item.word, forceRefresh: true }, (newContent) => {
                    if (newContent) showQuizItem(newContent, true);
                });
            };

            quizOptions.querySelector('#pop-next-word').onclick = () => {
                currentQuizIdx++;
                showQuizItem(currentQuiz[currentQuizIdx]);
            };
        }

        renderCard();
    }

    function handleQuizAnswer(btn, selected, correct, word) {
        const isCorrect = selected === correct;
        Array.from(quizOptions.children).forEach(b => {
            b.disabled = true;
            if (b.textContent === correct) b.classList.add('correct');
            else if (b.textContent === selected && !isCorrect) b.classList.add('incorrect');
        });

        quizFeedback.classList.remove('hidden');
        quizFeedback.textContent = isCorrect ? "Correct! Proficiency increased." : `Not quite. The correct answer was "${correct}".`;
        quizFeedback.style.background = isCorrect ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        quizFeedback.style.color = isCorrect ? '#15803d' : '#b91c1c';

        chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', word, interaction: isCorrect ? 'quiz_correct' : 'quiz_incorrect' });

        const nextBtn = document.createElement('button');
        nextBtn.className = 'primary-btn';
        nextBtn.style.marginTop = '16px';
        nextBtn.textContent = currentQuizIdx < currentQuiz.length - 1 ? "Next Word" : "Finish";
        nextBtn.addEventListener('click', () => {
            currentQuizIdx++;
            if (currentQuizIdx < currentQuiz.length) {
                showQuizItem(currentQuiz[currentQuizIdx]);
            } else {
                showQuizItem(null);
            }
        });
        quizFeedback.appendChild(nextBtn);
    }

    const simplifyPageBtn = document.getElementById('simplify-page-btn');
    if (simplifyPageBtn) {
        simplifyPageBtn.addEventListener('click', async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                chrome.tabs.sendMessage(tab.id, { type: 'START_SIMPLIFY' }, (res) => {
                    simplifyPageBtn.textContent = '🚀 Simplifying...';
                    simplifyPageBtn.style.background = '#4f46e5';
                    setTimeout(() => {
                        simplifyPageBtn.textContent = '✨ Simplify This Page';
                        simplifyPageBtn.style.background = 'linear-gradient(135deg, #9333ea 0%, #4f46e5 100%)';
                        window.close();
                    }, 1000);
                });
            }
        });
    }

    let cachedInsight = null;

    tabHome.addEventListener('click', () => {
        tabHome.classList.add('active');
        tabLessons.classList.remove('active');
        homeView.classList.remove('hidden');
        lessonsView.classList.add('hidden');
    });

    tabLessons.addEventListener('click', () => {
        tabHome.classList.remove('active');
        tabLessons.classList.add('active');
        homeView.classList.add('hidden');
        lessonsView.classList.remove('hidden');
        loadLessonsLearned(false);
    });

    // Sub-tab logic for Lessons Learned
    const subTabCoach = document.getElementById('sub-tab-coach');
    const subTabVocab = document.getElementById('sub-tab-vocab');
    const coachSubView = document.getElementById('coach-sub-view');
    const vocabSubView = document.getElementById('vocab-sub-view');

    if (subTabCoach && subTabVocab) {
        subTabCoach.addEventListener('click', () => {
            subTabCoach.classList.add('active');
            subTabVocab.classList.remove('active');
            coachSubView.classList.remove('hidden');
            vocabSubView.classList.add('hidden');
        });

        subTabVocab.addEventListener('click', () => {
            subTabVocab.classList.add('active');
            subTabCoach.classList.remove('active');
            vocabSubView.classList.remove('hidden');
            coachSubView.classList.add('hidden');
        });
    }

    async function loadLessonsLearned(forceRefresh = false) {
        // Only refresh AI summary if forced or not cached
        const shouldRefreshAI = forceRefresh || !cachedInsight;

        if (shouldRefreshAI) {
            insightsLoading.classList.remove('hidden');
            insightsDisplay.classList.add('hidden');
        }

        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
        const apiKeyWarning = document.getElementById('api-key-warning');
        if (apiKeyWarning) {
            apiKeyWarning.classList.toggle('hidden', !!openaiKey);
        }

        chrome.runtime.sendMessage({ type: 'GET_LEARNING_INSIGHTS' }, (data) => {
            if (shouldRefreshAI) {
                insightsLoading.classList.add('hidden');
                insightsDisplay.classList.remove('hidden');
            }

            const lessonsEmptyMsg = document.getElementById('lessons-empty-msg');

            if (data && data.insight) {
                if (shouldRefreshAI) {
                    cachedInsight = data.insight;
                    renderInsightWithTooltips(data.insight, aiInsightText);
                } else if (cachedInsight) {
                    renderInsightWithTooltips(cachedInsight, aiInsightText);
                }

                if (data.words && data.words.length > 0) {
                    lessonsEmptyMsg.classList.add('hidden');
                    wordList.innerHTML = '';
                    data.words.forEach(item => {
                        const word = typeof item === 'string' ? item : item.word;
                        const hasVaulted = typeof item === 'object' && item.hasVaulted;

                        const li = document.createElement('li');
                        li.className = 'focus-word-item';
                        li.innerHTML = `
                            <span style="font-weight: 500;">${word}</span>
                            <div style="display: flex; gap: 4px;">
                                <button class="icon-btn wiki-word-btn" title="Search Wikipedia">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>
                                </button>
                                <button class="icon-btn examples-word-btn" title="Examples">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                                </button>
                                ${hasVaulted ? `
                                <button class="icon-btn vault-word-btn" title="View Vaulted Sentences" style="color: #f59e0b;">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                                </button>
                                ` : ''}
                                <button class="icon-btn delete-word-btn" title="Delete Word">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </button>
                            </div>
                        `;

                        li.querySelector('.wiki-word-btn').onclick = () => {
                            window.open(`https://simple.wikipedia.org/w/index.php?search=${encodeURIComponent(word)}`, '_blank');
                        };

                        li.querySelector('.examples-word-btn').onclick = () => {
                            practiceWordTitle.textContent = `Examples: ${word}`;
                            practiceDisplay.classList.add('hidden');
                            practiceLoading.classList.remove('hidden');
                            practicePanel.classList.remove('hidden');
                            chrome.runtime.sendMessage({ type: 'GET_PRACTICE_CONTENT', word }, (content) => {
                                if (content) showQuizItem(content);
                            });
                        };

                        if (hasVaulted) {
                            li.querySelector('.vault-word-btn').onclick = () => {
                                showVaultDetails(word);
                            };
                        }

                        li.querySelector('.delete-word-btn').onclick = () => {
                            if (confirm(`Delete "${word}" from your learning list?`)) {
                                chrome.runtime.sendMessage({ type: 'DELETE_WORD', word }, (res) => {
                                    if (res && res.success) {
                                        li.remove();
                                        if (wordList.children.length === 0) lessonsEmptyMsg.classList.remove('hidden');
                                        updateStats();
                                    }
                                });
                            }
                        };
                        wordList.appendChild(li);
                    });
                } else {
                    lessonsEmptyMsg.classList.remove('hidden');
                    wordList.innerHTML = '';
                }
            } else {
                aiInsightText.textContent = "Insights taking shape... Keep reading!";
                lessonsEmptyMsg.classList.remove('hidden');
            }
        });
    }

    // --- VAULT DETAIL VIEW ---
    const vaultDetailPanel = document.getElementById('vault-detail-panel');
    const vaultWordTitle = document.getElementById('vault-word-title');
    const vaultSentenceList = document.getElementById('vault-sentence-list');
    const closeVaultDetail = document.getElementById('close-vault-detail');

    async function showVaultDetails(word, predefinedSentences = null) {
        vaultWordTitle.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: flex-start;">
                <span style="font-size: 1.5rem; font-weight: 700; color: var(--accent);">${word}</span>
                <span style="font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;">Difficult Contexts</span>
            </div>
        `;
        vaultSentenceList.innerHTML = '<div class="spinner"></div>';
        vaultDetailPanel.classList.remove('hidden');

        let sentences = predefinedSentences;
        if (!sentences) {
            const allSentences = await new Promise(resolve =>
                chrome.runtime.sendMessage({ type: 'GET_MISUNDERSTOOD_SENTENCES' }, resolve)
            );
            sentences = allSentences ? allSentences.filter(s => s.word.toLowerCase() === word.toLowerCase()) : [];
        }

        vaultSentenceList.innerHTML = '';
        if (sentences.length === 0) {
            vaultSentenceList.innerHTML = '<p class="stat-label">No sentences found.</p>';
            return;
        }

        sentences.sort((a, b) => b.timestamp - a.timestamp).forEach(item => {
            const li = document.createElement('li');
            li.className = 'vault-sentence-item';
            li.innerHTML = `
                <div style="flex: 1;">
                    <div style="font-size: 0.65rem; color: var(--text-dim); margin-bottom: 4px;">${new Date(item.timestamp).toLocaleDateString()}</div>
                    <div style="font-size: 0.85rem; line-height: 1.5;">"${item.sentence}"</div>
                </div>
                <button class="icon-btn delete-vault-btn" title="I understand this now">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            `;

            li.querySelector('.delete-vault-btn').onclick = () => {
                chrome.runtime.sendMessage({ type: 'DELETE_MISUNDERSTOOD_SENTENCE', id: item.id }, (res) => {
                    if (res && res.success) {
                        const remaining = sentences.filter(s => s.id !== item.id);
                        if (remaining.length === 0) {
                            vaultDetailPanel.classList.add('hidden');
                            tabLessons.click();
                        } else {
                            showVaultDetails(word, remaining);
                        }
                    }
                });
            };
            vaultSentenceList.appendChild(li);
        });
    }

    closeVaultDetail.onclick = () => vaultDetailPanel.classList.add('hidden');

    // Debug Logic
    openDebug.addEventListener('click', () => {
        debugPanel.classList.remove('hidden');
        refreshDebugTable();
    });

    closeDebug.addEventListener('click', () => debugPanel.classList.add('hidden'));

    document.getElementById('debug-mock-ai').onclick = () => {
        const mockInsight = `Based on your recent activity, your main weakness lies in [[nuanced academic verbs|Words like 'mitigate' or 'exacerbate' that describe changes]] and [[technical transitions|Words that connect complex ideas]]. 
        
        Strategic Advice: You should focus on how these words alter the tone of scientific texts. Try reading more journals to see them in context. 
        
        Pro Tip: Pay attention to [[collocations|Words that naturally go together]] like 'significantly mitigate'.`;

        tabLessons.click(); // Switch to lessons tab
        setTimeout(() => {
            renderInsightWithTooltips(mockInsight, aiInsightText);
        }, 100);
    };

    async function refreshDebugTable() {
        chrome.runtime.sendMessage({ type: 'DEBUG_GET_ALL_WORDS' }, (words) => {
            vocabBody.innerHTML = '';
            if (words && Array.isArray(words)) {
                words.sort((a, b) => b.proficiency - a.proficiency).forEach(w => {
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                    tr.innerHTML = `
                        <td style="padding: 6px;">${w.word}</td>
                        <td style="padding: 6px;">${(w.proficiency || 0).toFixed(2)}</td>
                        <td style="padding: 6px; display: flex; gap: 4px; align-items: center;">
                            <span>${(w.stability || 0).toFixed(2)}</span>
                            <button class="icon-btn mock-word-btn" data-word="${w.word}" title="Mock for Practice" style="color: var(--accent); padding: 2px;">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                            </button>
                        </td>
                    `;
                    tr.querySelector('.mock-word-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        chrome.runtime.sendMessage({ type: 'DEBUG_MOCK_DATA', word: w.word }, (res) => {
                            if (res && res.success) refreshDebugTable();
                        });
                    });
                    vocabBody.appendChild(tr);
                });
            }
        });
    }

    if (resetDbBtn) {
        resetDbBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to reset ALL learning data? This will clear EVERYTHING.')) {
                chrome.runtime.sendMessage({ type: 'DEBUG_RESET_DB' }, (res) => {
                    if (res && res.success) {
                        alert('System reset complete.');
                        location.reload();
                    }
                });
            }
        });
    }

    if (forceDecayBtn) {
        forceDecayBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'DEBUG_FORCE_DECAY', days: 7 }, (res) => {
                if (res && res.success) refreshDebugTable();
            });
        });
    }

    const debugMockDataBtn = document.getElementById('debug-mock-data');
    if (debugMockDataBtn) {
        debugMockDataBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'DEBUG_MOCK_DATA' }, (res) => {
                if (res && res.success) {
                    refreshDebugTable();
                    updateStats();
                }
            });
        });
    }
});
