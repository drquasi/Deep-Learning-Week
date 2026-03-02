// fluentify background script
importScripts('storage.js');

// set up everything when the extension is first installed
chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.set({
        enabled: true,
        autoSimplify: true,
        scannedCount: 0,
        learnedCount: 0
    });

    try {
        // start up the database
        await self.fluentifyStorage.init();
        console.log('fluentify Initialized.');
        // apply some decay so words get harder over time
        await applyDecay();

        // right click menu option for the user
        chrome.contextMenus.create({
            id: 'highlight-with-fluentify',
            title: 'Highlight with fluentify',
            contexts: ['selection']
        });

        // alarm for daily decay logic
        if (chrome.alarms) {
            chrome.alarms.create('decayAlarm', { periodInMinutes: 1440 });
        }
    } catch (err) {
        console.error('Initialization failed:', err);
    }
});

// handles when user clicks the right click menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'highlight-with-fluentify' && info.selectionText) {
        const word = info.selectionText.trim().split(/\s+/)[0].toLowerCase();
        if (word && tab?.id) {
            // log the interaction and tell content script to highlight it
            await handleInteraction(word, 'hover');
            chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_WORD', word });
        }
    }
});

// make sure db is ready and decay is applied when browser starts
chrome.runtime.onStartup.addListener(async () => {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        await applyDecay();
    } catch (err) {
        console.error('Startup decay failed:', err);
    }
});

// how much each action affects the student proficiency
const INTERACTION_IMPACT = {
    'hover': { proficiency: 0.05, stability: 0 },
    'simplify_click': { proficiency: -0.10, stability: -0.05 },
    'know_it_click': { proficiency: 0.20, stability: 0.10 },
    'context_seen': { proficiency: 0.01, stability: 0 },
    'quiz_correct': { proficiency: 0.15, stability: 0.30 },
    'quiz_incorrect': { proficiency: -0.05, stability: -0.10 },
    'practice_viewed': { proficiency: 0.10, stability: 0.15 }
};

// api urls for openai and proxy
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PROXY_URL = 'http://localhost:3000/simplify';
const EXAMPLES_PROXY_URL = 'http://localhost:3000/examples';
const CHAT_PROXY_URL = 'http://localhost:3000/chat';
const DICTIONARY_API_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

// helper function to talk to openai or the proxy if no key
async function callOpenAI(payload) {
    const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
    if (openaiKey) {
        // use the user's key if they have one
        const response = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
            body: JSON.stringify({
                ...payload,
                model: payload.model || 'gpt-3.5-turbo'
            })
        });
        if (!response.ok) throw new Error(`OpenAI API Error: ${response.status}`);
        const data = await response.json();
        return data.choices[0].message.content;
    } else {
        // fallback to proxy server if no key provided
        const response = await fetch(CHAT_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Proxy Error: ${response.status}`);
        const data = await response.json();
        return data.choices[0].message.content;
    }
}

// listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // big list of all things we can do
    const handlers = {
        'ANALYZE_PAGE': (msg) => processBatch(msg.url, msg.sentences),
        'PROCESS_BATCH': (msg) => processBatch(msg.url, msg.sentences),
        'FETCH_DEFINITION': (msg) => fetchDefinition(msg.word),
        'GET_DEFINITION': (msg) => fetchDefinition(msg.word),
        'GET_VOCAB_STATS': () => getVocabStats(),
        'UPDATE_PROFICIENCY': (msg) => self.fluentifyStorage.updateWordProficiency(msg.word, msg.delta, msg.stabilityDelta, msg.interactionType),
        'LOG_INTERACTION': (msg) => handleInteraction(word, msg.interaction),
        'GET_LEARNING_INSIGHTS': () => getLearningInsights(),
        'GET_PRACTICE_CONTENT': (msg) => getPracticeContent(msg.word, msg.forceRefresh),
        'GET_DAILY_QUIZ': () => getDailyQuiz(),
        'GET_READING_RECOMMENDATIONS': () => getReadingRecommendations(),
        'LOG_MISUNDERSTOOD': (msg) => self.fluentifyStorage.saveMisunderstoodSentence(msg.word, msg.sentence),
        'GET_MISUNDERSTOOD_SENTENCES': () => self.fluentifyStorage.getAllMisunderstoodSentences(),
        'DEBUG_RESET_DB': async () => {
            const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
            await chrome.storage.local.clear();
            if (openaiKey) await chrome.storage.local.set({ openaiKey });
            await self.fluentifyStorage.clearAll();
            return { success: true };
        },
        'DEBUG_FORCE_DECAY': (msg) => applyDecay(msg.days || 7),
        'DEBUG_GET_ALL_WORDS': () => self.fluentifyStorage.getAllWords(),
        'DEBUG_MOCK_DATA': (msg) => debugMockData(msg.word),
        'MARK_KNOWN': (msg) => handleInteraction(msg.word, 'know_it_click'),
        'SIMPLIFY_SENTENCE': (msg) => simplifySentence(msg.text),
        'DELETE_MISUNDERSTOOD_SENTENCE': (msg) => self.fluentifyStorage.deleteMisunderstoodSentence(msg.id),
        'DELETE_WORD': (msg) => self.fluentifyStorage.deleteWord(msg.word),
        'CHAT_WITH_TUTOR': (msg) => chatWithTutor(msg.text)
    };

    if (handlers[message.type]) {
        // run the handler and send back the result
        handlers[message.type](message)
            .then(res => sendResponse(res))
            .catch(err => {
                console.error(`Error in ${message.type} handler:`, err);
                sendResponse(null);
            });
        return true;
    }
});

// clean up sentence text for hashing
function normalizeSentence(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\u00C0-\u017F]/g, '')
        .trim();
}

// create a unique id for a sentence to cache results
async function hashSentence(sentence) {
    const CACHE_VERSION = 'v2_lenient';
    const encoder = new TextEncoder();
    const data = encoder.encode(CACHE_VERSION + sentence);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// big function to find all complex words on a page
async function processBatch(url, sentences) {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();

        const CACHE_VERSION = 'v2_lenient';
        // check if we already scanned this page before
        const cachedArticle = await self.fluentifyStorage.getArticle(url);
        if (cachedArticle && cachedArticle.version === CACHE_VERSION) {
            return cachedArticle.replacements;
        }

        const allIdentifications = {};
        const sentencesToAnalyze = [];
        for (let idx = 0; idx < sentences.length; idx++) {
            const original = sentences[idx];
            const normalized = normalizeSentence(original);
            if (!normalized) continue;

            const hash = await hashSentence(normalized);
            const cachedContext = await self.fluentifyStorage.getContext(hash);

            if (cachedContext) {
                // use cached words if we have them
                allIdentifications[original] = cachedContext.replacements;
            } else {
                sentencesToAnalyze.push({ original, normalized, hash });
            }
        }

        if (sentencesToAnalyze.length === 0) {
            await self.fluentifyStorage.saveArticle(url, allIdentifications, CACHE_VERSION);
            return allIdentifications;
        }

        // keep track of mastered words so we don't bother highlighting them
        const allWords = await self.fluentifyStorage.getAllWords();
        const masteredWords = new Set(allWords.filter(w => w.proficiency > 0.8).map(w => w.word));

        // split big pages into chunks so ai doesn't get overwhelmed
        const MAX_CHARS = 5000;
        const chunks = [];
        let currentChunk = [];
        let currentChars = 0;

        for (const item of sentencesToAnalyze) {
            if (currentChars + item.normalized.length > MAX_CHARS && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentChars = 0;
            }
            currentChunk.push(item);
            currentChars += item.normalized.length;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);

        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);

        // call ai for each chunk
        for (const chunk of chunks) {
            const chunkTexts = chunk.map(item => item.normalized);
            try {
                let response;
                if (openaiKey) {
                    // direct call to openai
                    response = await fetch(OPENAI_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({
                            model: 'gpt-3.5-turbo',
                            messages: [
                                { role: 'system', content: 'Identify complex English words for an Adult ESL learner. Return JSON { "complex_words": [] }' },
                                { role: 'user', content: JSON.stringify(chunkTexts) }
                            ],
                            response_format: { type: 'json_object' }
                        })
                    });
                } else {
                    // or via proxy
                    response = await fetch(PROXY_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sentences: chunkTexts })
                    });
                }

                if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);

                const data = await response.json();
                const result = openaiKey ? JSON.parse(data.choices[0].message.content) : data;
                let words = result.complex_words || (Array.isArray(result) ? result : []);

                // only keep words that are long enough and not mastered
                const filtered = words.filter(w =>
                    !masteredWords.has(w.toLowerCase()) &&
                    /^[\w\-\']{3,}$/.test(w)
                );

                for (const item of chunk) {
                    const segmentWords = filtered.filter(w => item.normalized.includes(w.toLowerCase()));
                    await self.fluentifyStorage.saveContext(item.hash, segmentWords);
                    allIdentifications[item.original] = segmentWords;
                }
            } catch (err) {
                console.error('Batch chunk error:', err);
                for (const item of chunk) {
                    if (!allIdentifications[item.original]) allIdentifications[item.original] = [];
                }
            }
        }

        // save the final results for this url
        await self.fluentifyStorage.saveArticle(url, allIdentifications, CACHE_VERSION);
        return allIdentifications;

    } catch (err) {
        console.error('ProcessBatch Global Error:', err);
        return {};
    }
}

// look up word definition using free dictionary api
async function fetchDefinition(word) {
    try {
        const encoded = encodeURIComponent(word.toLowerCase());
        const response = await fetch(`${DICTIONARY_API_URL}${encoded}`);
        if (!response.ok) return null;

        const data = await response.json();
        if (!data || !data[0]) return null;

        const entry = data[0];
        const meaning = entry.meanings[0];
        return {
            word: entry.word,
            definition: meaning.definitions[0].definition,
            partOfSpeech: meaning.partOfSpeech,
            synonym: meaning.synonyms && meaning.synonyms[0]
        };
    } catch (err) {
        console.error('Dictionary API Error:', err);
        return null;
    }
}

// update word score when user does something
async function handleInteraction(word, type) {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const impact = INTERACTION_IMPACT[type] || { proficiency: 0, stability: 0 };
        return await self.fluentifyStorage.updateWordProficiency(word, impact.proficiency, impact.stability, type);
    } catch (err) {
        console.error('Interaction Error:', err);
        return null;
    }
}

// generate the big ai coaching report
async function getLearningInsights() {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const allWords = await self.fluentifyStorage.getAllWords();
        const misunderstood = await self.fluentifyStorage.getAllMisunderstoodSentences();
        const vaultedWords = new Set(misunderstood.map(m => m.word.toLowerCase()));

        // get everything the student is working on
        const discoveredWords = allWords.filter(w => w.isDiscovered).map(w => w.word.toLowerCase());
        const combinedWordSet = new Set([...discoveredWords, ...vaultedWords]);

        const focalWords = Array.from(combinedWordSet).sort();

        // pick words to complain about in the report
        const struggling = allWords
            .filter(w => combinedWordSet.has(w.word.toLowerCase()) && w.proficiency < 0.9)
            .sort((a, b) => b.contextCount - a.contextCount)
            .slice(0, 10);

        const wordsData = focalWords.map(word => ({
            word,
            hasVaulted: vaultedWords.has(word.toLowerCase())
        })).reverse();

        if (focalWords.length === 0) {
            return { insight: "Insights taking shape... Keep reading to discover more words.", words: [] };
        }

        let insight = `You're focusing on ${focalWords.length} words. Keep practicing to build mastery!`;

        const { coachLanguage = 'English' } = await chrome.storage.local.get(['coachLanguage']);

        // get a summary of what they are struggling with
        const targetWords = struggling.length > 0 ? struggling : allWords.filter(w => combinedWordSet.has(w.word.toLowerCase())).slice(0, 10);
        const wordSummary = targetWords.map(w => `${w.word} (Seen ${w.contextCount}x, Proficiency: ${(w.proficiency * 100).toFixed(0)}%)`).join(', ');
        const vaultedContext = misunderstood.slice(0, 5).map(m => `"${m.sentence}" (Trouble with: ${m.word})`).join('\n');

        try {
            // tell ai to be a strict coach but in the right language
            const prompt = `Analyze this student's progress and provide an ELITE ESL coaching report.
            
            STRICT LANGUAGE RULE: Provide the ENTIRE response (including headers, categories, advice, and tips) strictly in ${coachLanguage}.
            
            STUDENT DATA:
            - Current Focal Words: ${wordSummary}
            - Difficult Contexts:
            ${vaultedContext}
            
            REPORT STRUCTURE (Translate these headers to ${coachLanguage}):
            ### 📊 Weakness Classification
            Identify the specific categories of English they are working on or struggling with.
            
            ### 💡 Tailored Advice
            Provide 2-3 specific, actionable strategies on how to move their proficiency to 100% for these EXACT words.
            
            ### 🎓 Pro Coaching Tip
            A final sophisticated tip for their level.
            
            STRICT RULE: You MUST use the syntax [[word|tooltip]] for at least 3 sophisticated terms in your response. The tip inside the tooltip must also be in ${coachLanguage}.
            Example: "You should focus on [[nuance|A subtle difference in meaning]] in your reading." (but translated to ${coachLanguage}).
            
            Be professional, analytical, and discouraging of simple mistakes. Respond in Markdown.`;

            const aiResponse = await callOpenAI({
                messages: [
                    { role: 'system', content: `You are an elite ESL Coach helping advanced learners. Your reports are structured, analytical, and highly professional. You use clear Markdown headers. You respond strictly in ${coachLanguage}.` },
                    { role: 'user', content: prompt }
                ]
            });
            if (aiResponse) insight = aiResponse;
        } catch (apiErr) {
            console.warn('AI Insights Error:', apiErr);
        }

        return { insight, words: wordsData };
    } catch (err) {
        console.error('getLearningInsights Global Error:', err);
        return { insight: "Insights unavailable.", words: [] };
    }
}

// make scores go down if student hasn't practiced in a while
async function applyDecay(manualDays = 0) {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const db = self.fluentifyStorage.db;
        const transaction = db.transaction(['vocabulary'], 'readwrite');
        const store = transaction.objectStore('vocabulary');
        const request = store.getAll();

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const words = request.result;
                const now = Date.now();
                const dayMs = 1000 * 60 * 60 * 24;

                words.forEach(wordData => {
                    const actualDiff = (now - wordData.lastInteraction) / dayMs;
                    const dayDiff = actualDiff + manualDays;

                    // if it's been more than a day, start forgetting
                    if (dayDiff > 1) {
                        wordData.proficiency = Math.max(0.01, wordData.proficiency - (wordData.decayRate * Math.log1p(dayDiff)));
                        store.put(wordData);
                    }
                });
            };
            transaction.oncomplete = () => resolve({ success: true, count: request.result ? request.result.length : 0 });
            transaction.onerror = (e) => reject(e);
        });
    } catch (err) {
        console.error('Decay Error:', err);
        return { success: false };
    }
}

// get quick stats for the home tab
async function getVocabStats() {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const allWords = await self.fluentifyStorage.getAllWords();
        const discoveredWords = allWords.filter(w => w.isDiscovered);
        return {
            total: discoveredWords.length,
            mastered: discoveredWords.filter(w => w.proficiency > 0.8).length
        };
    } catch (err) {
        return { total: 0, mastered: 0 };
    }
}

// get sentences so the student can practice a specific word
async function getPracticeContent(word, forceRefresh = false) {
    // some default sentences if ai fails
    const fallback = {
        quiz: null,
        sentences: [
            `The scientist's theory was eventually confirmed by colleagues who had observed similar results using the word ${word}.`,
            `After hours of debate, the committee finally decided that the context for ${word} was sound.`,
            `The evidence strongly suggested a different outcome than what they had initially expected for ${word}.`,
            `It is important to consider all available evidence before you form a final opinion on ${word}.`,
            `The study was completed after three years of intensive data collection regarding ${word}.`,
            `Most historians have agreed that ${word} changed the course of local politics.`
        ],
        isFallback: true
    };

    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();

        if (!forceRefresh) {
            // check if we already have some cached
            const cached = await self.fluentifyStorage.getPracticeContent(word);
            if (cached && cached.sentences && cached.sentences.length >= 6) return cached;
        }

        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
        const defData = await fetchDefinition(word);
        const contextInfo = defData ? `(Definition: ${defData.definition}, Part of Speech: ${defData.partOfSpeech})` : "";

        let content;
        if (openaiKey) {
            // ask ai to write 6 unique sentences
            const prompt = `As an expert linguist, create exactly 6 DIVERSE and UNIQUE high-quality organic sentences for the word "${word}" ${contextInfo}. 
Ensure these sentences are different from common dictionary examples. [Seed: ${Date.now()}]
Return a JSON object:
{
  "quiz": null,
  "sentences": [
    "Sentence containing '${word}'.",
    "Sentence containing '${word}'.",
    "Sentence containing '${word}'.",
    "Sentence containing '${word}'.",
    "Sentence containing '${word}'.",
    "Sentence containing '${word}'."
  ]
}
STRICT RULES:
1. WORD INCLUSION: The word "${word}" MUST appear in every sentence.
2. NO META-SENTENCES.
3. Exactly 6 sentences. JSON only.`;

            const response = await fetch(OPENAI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                body: JSON.stringify({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: 'json_object' }
                })
            });

            if (response.ok) {
                const data = await response.json();
                content = JSON.parse(data.choices[0].message.content);
            }
        } else {
            // ask local proxy for help
            const response = await fetch(EXAMPLES_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word, contextInfo })
            });
            if (response.ok) {
                content = await response.json();
            }
        }

        if (!content || !content.sentences) return fallback;

        // make sure the sentences actually have the word in them
        const uniqueSentences = Array.from(new Set(content.sentences.map(s => s.trim())));
        const validatedSentences = uniqueSentences.filter(s => s.toLowerCase().includes(word.toLowerCase()));

        if (validatedSentences.length < 3) return fallback;

        const finalContent = { ...content, sentences: validatedSentences };
        await self.fluentifyStorage.savePracticeContent(word, finalContent);
        return finalContent;
    } catch (err) {
        console.error('Practice Content Error:', err);
        return fallback;
    }
}

// get some words for the student to review today
async function getDailyQuiz() {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const allWords = await self.fluentifyStorage.getAllWords();
        // pick words with low scores
        const dueWords = allWords
            .filter(w => w.isDiscovered && w.proficiency < 0.9)
            .sort((a, b) => a.proficiency - b.proficiency)
            .slice(0, 3);

        if (dueWords.length === 0) return null;
        const quizItems = await Promise.all(dueWords.map(w => getPracticeContent(w.word)));
        return quizItems.filter(item => item !== null).map((item, idx) => ({ ...item, word: dueWords[idx].word }));
    } catch (err) {
        return null;
    }
}

// find a wikipedia page to read based on what student is struggling with
async function getReadingRecommendations() {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const allWords = await self.fluentifyStorage.getAllWords();
        const struggling = allWords.filter(w => w.isDiscovered && w.proficiency < 0.5 && w.contextCount > 1).slice(0, 3);

        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
        let link = "https://simple.wikipedia.org/wiki/Main_Page";
        let reason = "Practice your vocabulary with simple English articles.";

        if (struggling.length > 0) {
            const wordsStr = struggling.map(w => w.word).join(', ');
            if (openaiKey) {
                // ask ai for a good topic
                const prompt = `Based on: ${wordsStr}, suggest ONE specific Wikipedia topic. Return JSON: { "url": "...", "reason": "..." }`;
                try {
                    const response = await fetch(OPENAI_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({
                            model: 'gpt-3.5-turbo',
                            messages: [{ role: 'user', content: prompt }],
                            response_format: { type: 'json_object' }
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        const res = JSON.parse(data.choices[0].message.content);
                        return { link: res.url, reason: res.reason };
                    }
                } catch (e) { console.error("Rec API Error", e); }
            }
            link = `https://simple.wikipedia.org/w/index.php?search=${encodeURIComponent(struggling[0].word)}`;
            reason = `Search for "${struggling[0].word}" on Wikipedia to see it in a new context.`;
        }

        return { link, reason };
    } catch (err) {
        return { link: "https://simple.wikipedia.org/wiki/Main_Page", reason: "Keep reading to get personalized recommendations!" };
    }
}

// just for testing stuff
async function debugMockData(specificWord) {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const testWords = specificWord ? [specificWord] : ['comprehensive', 'infrastructure', 'mitigate', 'resilient', 'paradigm'];

        const db = self.fluentifyStorage.db;
        const transaction = db.transaction(['vocabulary'], 'readwrite');
        const store = transaction.objectStore('vocabulary');

        testWords.forEach(w => {
            store.put({
                word: w,
                isDiscovered: true,
                proficiency: 0.35 + (Math.random() * 0.1),
                stability: 0.2,
                decayRate: 0.1,
                contextCount: 3,
                lastSeen: Date.now(),
                lastInteraction: Date.now() - (1000 * 60 * 60 * 24 * 2)
            });
        });

        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve({ success: true });
            transaction.onerror = (e) => reject(e);
        });
    } catch (err) {
        console.error('Mock Error:', err);
        return { success: false };
    }
}

// talk to the friendly ai tutor
async function chatWithTutor(text) {
    try {
        if (!self.fluentifyStorage.db) await self.fluentifyStorage.init();
        const allWords = await self.fluentifyStorage.getAllWords();
        const focalWords = allWords.filter(w => w.isDiscovered).map(w => w.word);
        const misunderstood = await self.fluentifyStorage.getAllMisunderstoodSentences();
        const vaultedSentences = misunderstood.map(m => `"${m.sentence}" (${m.word})`).join('\n');

        const systemPrompt = `You are a friendly and encouraging AI Tutor. Your objective is to help advanced ESL learners master complex vocabulary. 
        Context details for the user:
        - Focal words discovered: ${focalWords.join(', ')}
        - Sentences they found difficult:
        ${vaultedSentences}

        Be concise, helpful, and provide examples when explaining words. Keep responses to under 4 sentences.`;

        const content = await callOpenAI({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ]
        });

        return { text: content };
    } catch (err) {
        console.error('Chat Error:', err);
        return { text: "I'm having a little trouble thinking right now. Please check your connection." };
    }
}

// make a hard sentence easier to read
async function simplifySentence(text) {
    try {
        const content = await callOpenAI({
            messages: [
                { role: 'system', content: 'You are a helpful assistant that simplifies complex English sentences for non-native speakers. Your goal is to make the meaning crystal clear while preserving the original intent. Keep the simplified version concise.' },
                { role: 'user', content: `Please simplify this sentence: "${text}"` }
            ]
        });
        return content;
    } catch (err) {
        console.error('Simplify Error:', err);
        return text;
    }
}
