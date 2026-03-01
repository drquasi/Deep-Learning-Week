// AdaptiRead Background Service Worker
importScripts('storage.js');

chrome.runtime.onInstalled.addListener(async () => {
    // Initialize default settings
    chrome.storage.local.set({
        enabled: true,
        level: 'A2',
        scannedCount: 0,
        learnedCount: 0
    });

    await self.adaptiReadStorage.init();
    console.log('AdaptiRead Initialized with IndexedDB.');
});

// Proficiency impact mapping based on proposal
const INTERACTION_IMPACT = {
    'hover_short': 0.05,  // Casual curiosity
    'hover_long': 0.0,   // Flag for review (struggling)
    'know_this': 0.3,    // Significant boost
    'simplify': -0.1,    // Difficulty confirmed (accelerate decay/lower mastery)
    'passive': 0.01      // Passive exposure
};

// Mock context-aware AI simulation
const SYNONYM_MAP = {
    "bank": [
        { synonym: "financial institution", contextKeywords: ["money", "finance", "loan", "account"] },
        { synonym: "river side", contextKeywords: ["river", "water", "fishing", "boat"] }
    ],
    "gregarious": [{ synonym: "sociable", contextKeywords: [] }],
    "mitigate": [{ synonym: "reduce", contextKeywords: [] }]
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'LOG_INTERACTION') {
        handleInteraction(message.word, message.interaction);
        return true;
    }

    if (message.type === 'GET_SIMPLIFICATION') {
        getSimplification(message.word, message.context).then(sendResponse);
        return true;
    }

    if (message.type === 'GET_ANALYTICS') {
        getAnalytics().then(sendResponse);
        return true;
    }
});

async function getAnalytics() {
    if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();

    const db = self.adaptiReadStorage.db;
    const transaction = db.transaction(['vocabulary', 'interactions'], 'readonly');
    const vocabStore = transaction.objectStore('vocabulary');

    return new Promise((resolve) => {
        const vocabRequest = vocabStore.getAll();
        vocabRequest.onsuccess = () => {
            const words = vocabRequest.result;
            const learnedCount = words.filter(w => w.proficiency >= 0.8).length;
            const strugglingWords = words
                .filter(w => w.proficiency < 0.5)
                .sort((a, b) => b.interactionCount - a.interactionCount)
                .slice(0, 5)
                .map(w => w.word);

            resolve({
                learnedCount: learnedCount,
                strugglingWords: strugglingWords,
                totalWords: words.length
            });
        };
    });
}

async function getSimplification(word, context) {
    const normalizedWord = word.toLowerCase();
    const options = SYNONYM_MAP[normalizedWord];

    if (!options) return null;
    if (options.length === 1) return options[0].synonym;

    // Simple keyword matching for "context-aware" simulation
    const contextLower = context.toLowerCase();
    for (const opt of options) {
        if (opt.contextKeywords.some(k => contextLower.includes(k))) {
            return opt.synonym;
        }
    }

    return options[0].synonym; // Default to first
}

async function handleInteraction(word, type) {
    try {
        if (!self.adaptiReadStorage.db) {
            await self.adaptiReadStorage.init();
        }

        const delta = INTERACTION_IMPACT[type] || 0;
        const updatedData = await self.adaptiReadStorage.updateWordProficiency(word, delta, type);

        console.log(`Updated state for "${word}":`, updatedData);

        // If proficiency > 0.8, increment learned count in storage
        if (updatedData.proficiency >= 0.8) {
            const settings = await chrome.storage.local.get(['learnedCount']);
            const current = settings.learnedCount || 0;
            // In a real app, we'd check if this transitioned from <0.8 to >0.8
            // For now, let's just let it be.
        }
    } catch (err) {
        console.error('Failed to handle interaction:', err);
    }
}
// Simulate Ebbinghaus Forgetting Curve Decay
async function applyDecay() {
    if (!self.adaptiReadStorage.db) await self.adaptiReadStorage.init();

    const db = self.adaptiReadStorage.db;
    const transaction = db.transaction(['vocabulary'], 'readwrite');
    const store = transaction.objectStore('vocabulary');

    const request = store.getAll();
    request.onsuccess = () => {
        const words = request.result;
        const now = Date.now();
        const recordsUpdated = [];

        words.forEach(wordData => {
            const timeSinceLast = (now - wordData.lastInteraction) / (1000 * 60 * 60 * 24); // days
            if (timeSinceLast > 1) {
                const decayAmount = wordData.decayRate * Math.log1p(timeSinceLast);
                const oldProficiency = wordData.proficiency;
                wordData.proficiency = Math.max(0, wordData.proficiency - decayAmount);

                if (oldProficiency !== wordData.proficiency) {
                    store.put(wordData);
                    recordsUpdated.push(wordData.word);
                }
            }
        });

        if (recordsUpdated.length > 0) {
            console.log(`Memory decay applied to ${recordsUpdated.length} words.`);
        }
    };
}

// Initial check
applyDecay();
// Check daily
chrome.alarms.create('decayAlarm', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'decayAlarm') applyDecay();
});
