// AdaptiRead Background Service Worker
importScripts('storage.js');

chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.set({
        enabled: true,
        autoSimplify: true,
        level: 'A2',
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
    'hover_short': 0.05,
    'hover_long': 0.0,
    'know_this': 0.3,
    'simplify': -0.1,
    'passive': 0.01
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

    if (message.type === 'GET_ANALYTICS') {
        getAnalytics().then(sendResponse);
        return true;
    }
});

async function processBatch(url, sentences) {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();

        const cachedArticle = await self.adaptiReadStorage.getArticle(url);
        if (cachedArticle) {
            console.log('Serving from Article Cache:', url);
            return cachedArticle.replacements; // Note: 'replacements' now stores identification array
        }

        const allIdentifications = {};
        const sentencesToAnalyze = [];
        const sentenceHashes = [];

        for (const sentence of sentences) {
            const hash = await hashSentence(sentence);
            const cachedContext = await self.adaptiReadStorage.getContext(hash);

            if (cachedContext) {
                allIdentifications[sentence] = cachedContext.replacements;
            } else {
                sentencesToAnalyze.push(sentence);
                sentenceHashes.push(hash);
            }
        }

        if (sentencesToAnalyze.length === 0) return allIdentifications;

        let response;
        const { openaiKey } = await chrome.storage.local.get(['openaiKey']);

        if (openaiKey) {
            console.log('Using Direct OpenAI Mode');
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
                            content: `Identify complex, advanced, or academic words. Return a JSON object where keys are sentences and values are arrays of complex words. Example: {"The melancholy king sat alone.": ["melancholy"]}`
                        },
                        {
                            role: 'user',
                            content: JSON.stringify(sentencesToAnalyze)
                        }
                    ],
                    response_format: { type: 'json_object' }
                })
            });
        } else {
            console.log('Using Secure Proxy Mode');
            response = await fetch(PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sentences: sentencesToAnalyze })
            });
        }

        const data = await response.json();
        console.log('AdaptiRead Background: AI response received', !!data);

        let aiReplacements;
        try {
            aiReplacements = openaiKey ? JSON.parse(data.choices[0].message.content) : data;
        } catch (e) {
            console.error('AdaptiRead Background: JSON Parse Error', e);
            return allIdentifications;
        }

        // Robust matching: trim and case-insensitive keys
        const aiKeys = Object.keys(aiReplacements).reduce((acc, k) => {
            acc[k.trim().toLowerCase()] = aiReplacements[k];
            return acc;
        }, {});

        for (let i = 0; i < sentencesToAnalyze.length; i++) {
            const sentence = sentencesToAnalyze[i];
            const hash = sentenceHashes[i];
            const normalizedSentence = sentence.trim().toLowerCase();
            const words = aiKeys[normalizedSentence] || [];

            if (Array.isArray(words) && words.length > 0) {
                await self.adaptiReadStorage.saveContext(hash, words);
                allIdentifications[sentence] = words;
            } else {
                // Save empty array to avoid re-scanning
                await self.adaptiReadStorage.saveContext(hash, []);
                allIdentifications[sentence] = [];
            }
        }

        await self.adaptiReadStorage.saveArticle(url, allIdentifications);
        console.log('AdaptiRead Background: Saved article results for', url);
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
        if (!response.ok) {
            console.log('AdaptiRead Background: No definition found in dictionary API');
            return null;
        }

        const data = await response.json();
        if (!data || !data[0]) return null;

        const entry = data[0];
        const meaning = entry.meanings[0];
        const results = {
            word: entry.word,
            definition: meaning.definitions[0].definition,
            partOfSpeech: meaning.partOfSpeech,
            synonym: meaning.synonyms && meaning.synonyms[0]
        };
        console.log('AdaptiRead Background: Final Meaning extracted:', results);
        return results;
    } catch (err) {
        console.error('Dictionary API Error:', err);
        return null;
    }
}

async function hashSentence(sentence) {
    const encoder = new TextEncoder();
    const data = encoder.encode(sentence.trim().toLowerCase());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleInteraction(word, type) {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const delta = INTERACTION_IMPACT[type] || 0;
        const updatedData = await self.adaptiReadStorage.updateWordProficiency(word, delta, type);
        console.log(`Proficiency update for "${word}":`, updatedData.proficiency);
    } catch (err) {
        console.error('Interaction Error:', err);
    }
}

async function applyDecay() {
    try {
        if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();
        const db = self.adaptiReadStorage.db;
        const transaction = db.transaction(['vocabulary'], 'readwrite');
        const store = transaction.objectStore('vocabulary');
        const request = store.getAll();
        request.onsuccess = () => {
            const words = request.result;
            const now = Date.now();
            words.forEach(wordData => {
                const dayDiff = (now - wordData.lastInteraction) / (1000 * 60 * 60 * 24);
                if (dayDiff > 1) {
                    wordData.proficiency = Math.max(0, wordData.proficiency - (wordData.decayRate * Math.log1p(dayDiff)));
                    store.put(wordData);
                }
            });
        };
    } catch (err) {
        console.error('Decay Error:', err);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'decayAlarm') applyDecay();
});
