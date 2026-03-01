/**
 * AdaptiRead Storage Module
 * Handles IndexedDB operations for the Proficiency Vector and Interaction History.
 */

const DB_NAME = 'AdaptiReadDB';
const DB_VERSION = 3; // Incremented to clear legacy replacements data
const STORE_VOCAB = 'vocabulary';
const STORE_INTERACTIONS = 'interactions';
const STORE_ARTICLES = 'articles';
const STORE_CONTEXTS = 'contexts';

class AdaptiReadStorage {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Vocabulary Store: { word, proficiency, lastInteraction, decayRate, contextTags }
                if (!db.objectStoreNames.contains(STORE_VOCAB)) {
                    db.createObjectStore(STORE_VOCAB, { keyPath: 'word' });
                }

                // Interaction Store: { id, word, type, timestamp, context }
                if (!db.objectStoreNames.contains(STORE_INTERACTIONS)) {
                    const interactionStore = db.createObjectStore(STORE_INTERACTIONS, { keyPath: 'id', autoIncrement: true });
                    interactionStore.createIndex('word', 'word', { unique: false });
                }

                // Article Cache Store: { url, replacements, timestamp }
                if (!db.objectStoreNames.contains(STORE_ARTICLES)) {
                    db.createObjectStore(STORE_ARTICLES, { keyPath: 'url' });
                }

                // Contextual Word Cache Store: { sentenceHash, replacements, timestamp }
                if (!db.objectStoreNames.contains(STORE_CONTEXTS)) {
                    db.createObjectStore(STORE_CONTEXTS, { keyPath: 'sentenceHash' });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    async getArticle(url) {
        return this.get(STORE_ARTICLES, url);
    }

    async saveArticle(url, replacements) {
        return this.put(STORE_ARTICLES, {
            url,
            replacements,
            timestamp: Date.now()
        });
    }

    async getContext(sentenceHash) {
        return this.get(STORE_CONTEXTS, sentenceHash);
    }

    async saveContext(sentenceHash, replacements) {
        return this.put(STORE_CONTEXTS, {
            sentenceHash,
            replacements,
            timestamp: Date.now()
        });
    }

    async getWord(word) {
        return this.get(STORE_VOCAB, word.toLowerCase());
    }

    async updateWordProficiency(word, delta, interactionType) {
        const normalizedWord = word.toLowerCase();
        let wordData = await this.getWord(normalizedWord);

        if (!wordData) {
            wordData = {
                word: normalizedWord,
                proficiency: 0.1, // Initial familiarity
                lastInteraction: Date.now(),
                decayRate: 0.1,
                interactionCount: 0
            };
        }

        // Interpret delta based on proposal logic
        const prevProficiency = wordData.proficiency;
        wordData.proficiency = Math.max(0, Math.min(1, wordData.proficiency + delta));
        wordData.lastInteraction = Date.now();
        wordData.interactionCount++;

        await this.put(STORE_VOCAB, wordData);

        // Log interaction
        await this.add(STORE_INTERACTIONS, {
            word: normalizedWord,
            type: interactionType,
            timestamp: Date.now()
        });

        return wordData;
    }

    // Generic DB methods
    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async put(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async add(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.add(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

// Export singleton instance
const storage = new AdaptiReadStorage();
if (typeof module !== 'undefined') {
    module.exports = storage;
} else {
    self.adaptiReadStorage = storage;
}
