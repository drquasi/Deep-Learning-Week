// AdaptiRead Background Service Worker
importScripts('storage.js');

chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.set({
        enabled: true,
        autoSimplify: true,
        scannedCount: 0,
        learnedCount: 0
    });

    try {
        await self.adaptiReadStorage.init();
        console.log('AdaptiRead Initialized.');
        await applyDecay();
        if (chrome.alarms) {
            chrome.alarms.create('decayAlarm', { periodInMinutes: 1440 });
        }
    } catch (err) {
        console.error('Initialization failed:', err);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        await applyDecay();
    } catch (err) {
        console.error('Startup decay failed:', err);
    }
});

const INTERACTION_IMPACT = {
    'hover': { proficiency: 0.05, stability: 0 },
    'simplify_click': { proficiency: -0.10, stability: -0.05 },
    'know_it_click': { proficiency: 0.20, stability: 0.10 },
    'context_seen': { proficiency: 0.01, stability: 0 },
    'quiz_correct': { proficiency: 0.30, stability: 0.20 }
};

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PROXY_URL = 'http://localhost:3000/simplify';
const DICTIONARY_API_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('AdaptiRead Background: Received message', message.type);
    if (message.type === 'LOG_INTERACTION') {
        handleInteraction(message.word, message.interaction);
        return true;
    }

    if (message.type === 'ANALYZE_PAGE') {
        console.log('AdaptiRead Background: Analyzing page', message.url);
        processBatch(message.url, message.sentences).then(res => {
            console.log('AdaptiRead Background: Analysis complete', Object.keys(res).length, 'blocks');
            sendResponse(res);
        });
        return true;
    }

    if (message.type === 'GET_DEFINITION') {
        fetchDefinition(message.word).then(sendResponse);
        return true;
    }

    if (message.type === 'GET_LEARNING_INSIGHTS') {
        generateLearningInsights().then(sendResponse);
        return true;
    }

    if (message.type === 'MARK_KNOWN') {
        handleInteraction(message.word, 'know_it_click').then(sendResponse);
        return true;
    }

    if (message.type === 'GET_VOCAB_STATS') {
        getVocabStats().then(sendResponse);
        return true;
    }

    // DEBUG HANDLERS
    if (message.type === 'DEBUG_RESET_DB') {
        self.adaptiReadStorage.clearAll().then(sendResponse);
        return true;
    }

    if (message.type === 'DEBUG_FORCE_DECAY') {
        applyDecay(message.days || 7).then(sendResponse);
        return true;
    }

    if (message.type === 'DEBUG_GET_ALL_WORDS') {
        self.adaptiReadStorage.getAllWords().then(sendResponse);
        return true;
    }
});

function normalizeSentence(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\u00C0-\u017F]/g, '')
        .trim();
}

async function processBatch(url, sentences) {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();

        const CACHE_VERSION = 'v2_lenient';
        const cachedArticle = await self.adaptiReadStorage.getArticle(url);
        if (cachedArticle && cachedArticle.version === CACHE_VERSION) {
            console.log('Serving from Article Cache:', url);
            return cachedArticle.replacements;
        }

        const allIdentifications = {};
        const sentencesToAnalyze = [];
        const normalizedSentences = sentences.map(s => normalizeSentence(s));

        for (let idx = 0; idx < sentences.length; idx++) {
            const original = sentences[idx];
            const normalized = normalizedSentences[idx];
            if (!normalized) continue;

            const hash = await hashSentence(normalized);
            const cachedContext = await self.adaptiReadStorage.getContext(hash);

            if (cachedContext) {
                allIdentifications[original] = cachedContext.replacements;
            } else {
                sentencesToAnalyze.push({ original, normalized, hash });
            }
        }

        if (sentencesToAnalyze.length === 0) {
            await self.adaptiReadStorage.saveArticle(url, allIdentifications);
            return allIdentifications;
        }

        console.log(`AdaptiRead Background: Processing ${sentencesToAnalyze.length} new segments`);

        const MAX_CHARS = 5500;
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

        // Concurrent processing
        const CONCURRENCY = 3;
        const allWordsFound = new Set();

        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (chunk) => {
                const chunkTexts = chunk.map(item => item.normalized);

                try {
                    let response;
                    if (openaiKey) {
                        response = await fetch(OPENAI_API_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${openaiKey}`
                            },
                            body: JSON.stringify({
                                model: 'gpt-3.5-turbo',
                                messages: [
                                    {
                                        role: 'system',
                                        content: `Identify all complex, academic, or specialized English words present in the provided text.
                                        TARGET AUDIENCE: ESL Adult Beginner (e.g., Chinese university student).
                                        RULES:
                                        1. Be LENIENT. Include any word that a student with limited reading experience might struggle with.
                                        2. Include academic vocabulary (AWL) and domain-specific terms.
                                        3. Return a JSON object with a single key "complex_words" containing an array of unique words.
                                        4. Exclude very common words and proper nouns.`
                                    },
                                    { role: 'user', content: JSON.stringify(chunkTexts) }
                                ],
                                response_format: { type: 'json_object' }
                            })
                        });
                    } else {
                        response = await fetch(PROXY_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sentences: chunkTexts })
                        });
                    }

                    if (!response.ok) {
                        for (const item of chunk) allIdentifications[item.original] = [];
                        return;
                    }

                    const data = await response.json();
                    let result;
                    try {
                        result = openaiKey ? JSON.parse(data.choices[0].message.content) : data;
                    } catch (e) { result = data; }

                    // Robust parsing: extract all words found in result regardless of structure
                    let words = [];
                    if (result.complex_words && Array.isArray(result.complex_words)) {
                        words = result.complex_words;
                    } else if (Array.isArray(result)) {
                        words = result;
                    } else if (typeof result === 'object' && result !== null) {
                        // Legacy/Fallback: Extract all array values from the object
                        Object.values(result).forEach(val => {
                            if (Array.isArray(val)) words.push(...val);
                        });
                    }

                    const uniqueWords = [...new Set(words)];
                    const filtered = uniqueWords.filter(word => /^[\w\-\'\u00C0-\u017F\s]+$/.test(word) && word.length > 2);

                    // Broadcast these words back to EVERY segment in this chunk
                    for (const item of chunk) {
                        const segmentWords = [];
                        for (const w of filtered) {
                            // Tutor: Skip words already mastered (proficiency > 0.8)
                            const wordObj = await self.adaptiReadStorage.getWord(w);
                            if (wordObj && wordObj.proficiency > 0.8) continue;

                            if (item.normalized.includes(w.toLowerCase())) {
                                segmentWords.push(w);
                                // Log context sighting for the tutor model (small passive gain)
                                await self.adaptiReadStorage.updateWordProficiency(w, 0.01, 0, 'context_seen');
                            }
                        }

                        await self.adaptiReadStorage.saveContext(item.hash, segmentWords);
                        allIdentifications[item.original] = segmentWords;
                    }
                } catch (err) {
                    console.error('Batch chunk error:', err);
                    for (const item of chunk) {
                        if (!allIdentifications[item.original]) allIdentifications[item.original] = [];
                    }
                }
            }));
        }

        await self.adaptiReadStorage.saveArticle(url, allIdentifications, CACHE_VERSION);
        return allIdentifications;

    } catch (err) {
        console.error('ProcessBatch Error:', err);
        return {};
    }
}

async function fetchDefinition(word) {
    try {
        console.log('AdaptiRead Background: Fetching definition for:', word);
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

async function hashSentence(sentence) {
    const CACHE_VERSION = 'v2_lenient'; // Increment this to force new analysis
    const encoder = new TextEncoder();
    const data = encoder.encode(CACHE_VERSION + sentence);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleInteraction(word, type) {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const impact = INTERACTION_IMPACT[type] || { proficiency: 0, stability: 0 };
        await self.adaptiReadStorage.updateWordProficiency(word, impact.proficiency, impact.stability, type);
    } catch (err) {
        console.error('Interaction Error:', err);
    }
}

async function generateLearningInsights() {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const allWords = await self.adaptiReadStorage.getAllWords();

        // Filter for "Struggling but Frequent" words
        const struggling = allWords
            .filter(w => w.proficiency < 0.6 && w.contextCount > 2)
            .sort((a, b) => b.contextCount - a.contextCount)
            .slice(0, 5);

        if (struggling.length === 0) return { insight: "You're doing great! Keep reading to discover more words." };

        const summary = struggling.map(w => `${w.word} (Seen ${w.contextCount}x, Proficiency: ${(w.proficiency * 100).toFixed(0)}%)`).join(', ');

        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);
        let response;
        const prompt = `Analyze this student's vocabulary struggle: ${summary}. 
            Provide a short, 2-sentence actionable coaching tip. 
            Focus on WHY they might be struggling with these specific words and give a Mnemonic or usage tip.`;

        if (openaiKey) {
            response = await fetch(OPENAI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                body: JSON.stringify({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'system', content: 'You are a helpful ESL Tutor.' }, { role: 'user', content: prompt }]
                })
            });
        } else {
            // Fallback: simplified coaching if no key
            return { insight: `You've seen "${struggling[0].word}" many times. Try using it in a sentence today!` };
        }

        const data = await response.json();
        return { insight: data.choices[0].message.content, words: struggling.map(w => w.word) };
    } catch (err) {
        console.error('Insights Error:', err);
        return { insight: "Analysis unavailable right now." };
    }
}

async function applyDecay(manualDays = 0) {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const db = self.adaptiReadStorage.db;
        const transaction = db.transaction(['vocabulary'], 'readwrite');
        const store = transaction.objectStore('vocabulary');
        const request = store.getAll();

        return new Promise((resolve) => {
            request.onsuccess = () => {
                const words = request.result;
                const now = Date.now();
                const dayMs = 1000 * 60 * 60 * 24;

                words.forEach(wordData => {
                    const actualDiff = (now - wordData.lastInteraction) / dayMs;
                    const dayDiff = actualDiff + manualDays;

                    if (dayDiff > 1) {
                        wordData.proficiency = Math.max(0, wordData.proficiency - (wordData.decayRate * Math.log1p(dayDiff)));
                        store.put(wordData);
                    }
                });
                resolve({ success: true, count: words.length });
            };
        });
    } catch (err) {
        console.error('Decay Error:', err);
        return { success: false };
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'decayAlarm') applyDecay();
});

async function getVocabStats() {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const allWords = await self.adaptiReadStorage.getAllWords();
        const discoveredWords = allWords.filter(w => w.isDiscovered);
        return {
            total: discoveredWords.length,
            mastered: discoveredWords.filter(w => w.proficiency > 0.8).length
        };
    } catch (err) {
        console.error('Stats Error:', err);
        return { total: 0, mastered: 0 };
    }
}
