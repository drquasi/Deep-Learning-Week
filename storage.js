// fluentify storage module
// this uses indexeddb to save the student's progress and words they've seen
// it's like a mini database inside the browser

const DB_NAME = 'fluentifyDB';
const DB_VERSION = 3; // incremented to clear legacy replacements data
const STORE_VOCAB = 'vocabulary';
const STORE_INTERACTIONS = 'interactions';
const STORE_ARTICLES = 'articles';
const STORE_CONTEXTS = 'contexts';
const STORE_PRACTICE = 'practice_content';
const STORE_MISUNDERSTOOD = 'misunderstood_sentences';

class fluentifyStorage {
    constructor() {
        this.db = null;
    }

    // open the database and setup the tables (object stores)
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // vocabulary store: where we keep the "proficiency vector" for each word
                if (!db.objectStoreNames.contains(STORE_VOCAB)) {
                    db.createObjectStore(STORE_VOCAB, { keyPath: 'word' });
                }

                // interaction store: logs every time a student hovers or clicks a word
                if (!db.objectStoreNames.contains(STORE_INTERACTIONS)) {
                    const interactionStore = db.createObjectStore(STORE_INTERACTIONS, { keyPath: 'id', autoIncrement: true });
                    interactionStore.createIndex('word', 'word', { unique: false });
                }

                // article cache store: remembers which words were highlighted on specific urls
                if (!db.objectStoreNames.contains(STORE_ARTICLES)) {
                    db.createObjectStore(STORE_ARTICLES, { keyPath: 'url' });
                }

                // contextual word cache store: saves ai analysis for specific sentences
                if (!db.objectStoreNames.contains(STORE_CONTEXTS)) {
                    db.createObjectStore(STORE_CONTEXTS, { keyPath: 'sentenceHash' });
                }

                // practice content store: keeps the flashcards and example sentences
                if (!db.objectStoreNames.contains(STORE_PRACTICE)) {
                    db.createObjectStore(STORE_PRACTICE, { keyPath: 'word' });
                }

                // misunderstood sentences store: for when the student clicks "difficult"
                if (!db.objectStoreNames.contains(STORE_MISUNDERSTOOD)) {
                    const store = db.createObjectStore(STORE_MISUNDERSTOOD, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('word', 'word', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    // getters and setters for the various stores
    async getArticle(url) {
        return this.get(STORE_ARTICLES, url);
    }

    async saveArticle(url, replacements, version = null) {
        return this.put(STORE_ARTICLES, {
            url,
            replacements,
            version,
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

    async getPracticeContent(word) {
        return this.get(STORE_PRACTICE, word.toLowerCase());
    }

    async savePracticeContent(word, content) {
        return this.put(STORE_PRACTICE, {
            word: word.toLowerCase(),
            ...content,
            timestamp: Date.now()
        });
    }

    // keep track of which sentences were hard for the student
    async saveMisunderstoodSentence(word, sentence) {
        const normalizedWord = word.toLowerCase();
        // check for duplicates first so we don't spam the same sentence
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(STORE_MISUNDERSTOOD, 'readonly');
            const store = transaction.objectStore(STORE_MISUNDERSTOOD);
            const index = store.index('word');
            const request = index.getAll(normalizedWord);

            request.onsuccess = async () => {
                const existing = request.result;
                const isDuplicate = existing.some(item => item.sentence === sentence);

                if (!isDuplicate) {
                    await this.add(STORE_MISUNDERSTOOD, {
                        word: normalizedWord,
                        sentence,
                        timestamp: Date.now()
                    });
                    resolve({ success: true, added: true });
                } else {
                    resolve({ success: true, added: false });
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteMisunderstoodSentence(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(STORE_MISUNDERSTOOD, 'readwrite');
            const store = transaction.objectStore(STORE_MISUNDERSTOOD);
            const request = store.delete(Number(id)); // ensure id is a number
            request.onsuccess = () => resolve({ success: true });
            request.onerror = () => reject(request.error);
        });
    }

    async getAllMisunderstoodSentences() {
        return this.getAll(STORE_MISUNDERSTOOD);
    }

    async getWord(word) {
        return this.get(STORE_VOCAB, word.toLowerCase());
    }

    async deleteWord(word) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(STORE_VOCAB, 'readwrite');
            const store = transaction.objectStore(STORE_VOCAB);
            const request = store.delete(word);
            request.onsuccess = () => resolve({ success: true });
            request.onerror = () => reject(request.error);
        });
    }

    // updating how well the student knows a word
    async updateWordProficiency(word, delta, stabilityDelta = 0, interactionType = 'hover') {
        const normalizedWord = word.toLowerCase();
        let wordData = await this.getWord(normalizedWord);

        // if it's a new word, initialize it with base values
        if (!wordData) {
            wordData = {
                word: normalizedWord,
                proficiency: 0.1, // initial familiarity
                stability: 0.5,   // initial memory stability
                lastInteraction: Date.now(),
                decayRate: 0.05,  // base decay rate
                interactionCount: 0,
                contextCount: 0,
                isDiscovered: false,
                history: []
            };
        }

        // apply the changes (like adding points for seeing it)
        wordData.proficiency = Math.max(0, Math.min(1, wordData.proficiency + delta));
        wordData.stability = Math.max(0.1, wordData.stability + stabilityDelta);
        wordData.lastInteraction = Date.now();
        wordData.interactionCount++;

        // mark as discovered if the student actually looked at the definition
        if (interactionType !== 'context_seen') {
            wordData.isDiscovered = true;
        }

        // track how many times it was just visible on screen
        if (interactionType === 'context_seen') {
            wordData.contextCount++;
        }

        // keep a short log of the last 5 things the student did with this word
        wordData.history.push({ type: interactionType, time: Date.now() });
        if (wordData.history.length > 5) wordData.history.shift();

        await this.put(STORE_VOCAB, wordData);

        // detailed interaction log for stats
        await this.add(STORE_INTERACTIONS, {
            word: normalizedWord,
            type: interactionType,
            timestamp: Date.now()
        });

        return wordData;
    }

    async getAllWords() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(STORE_VOCAB, 'readonly');
            const store = transaction.objectStore(STORE_VOCAB);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // reset everything back to zero
    async clearAll() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_VOCAB, STORE_INTERACTIONS, STORE_ARTICLES, STORE_CONTEXTS, STORE_PRACTICE, STORE_MISUNDERSTOOD], 'readwrite');
            transaction.objectStore(STORE_VOCAB).clear();
            transaction.objectStore(STORE_INTERACTIONS).clear();
            transaction.objectStore(STORE_ARTICLES).clear();
            transaction.objectStore(STORE_CONTEXTS).clear();
            transaction.objectStore(STORE_PRACTICE).clear();
            transaction.objectStore(STORE_MISUNDERSTOOD).clear();
            transaction.oncomplete = () => resolve({ success: true });
            transaction.onerror = () => reject(transaction.error);
        });
    }

    // generic helper methods for indexeddb operations
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
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async add(storeName, data) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.add(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

// export as a singleton so everyone uses the same db connection
const storage = new fluentifyStorage();
if (typeof module !== 'undefined') {
    module.exports = storage;
} else {
    self.fluentifyStorage = storage;
}
