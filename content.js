// AdaptiRead Content Script - Dictionary Lookup Strategy
let isEnabled = true;
let processedNodes = new WeakSet();
let scanTimeout = null;
let activeTooltip = null;
let globalLoadingIndicator = null;
let hasScannedOnThisPage = false;
let isScanningActive = false;

function normalizeSentence(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\u00C0-\u017F]/g, '')
        .trim();
}

const TOOLTIP_CSS = `
.adaptiread-highlight {
    background-image: linear-gradient(120deg, rgba(122, 199, 255, 0.3) 0%, rgba(122, 199, 255, 0.3) 100%);
    background-repeat: no-repeat;
    background-size: 100% 0.2em;
    background-position: 0 88%;
    transition: background-size 0.25s ease-in;
    cursor: help;
    border-bottom: 1px dashed #7ac7ff;
}
.adaptiread-highlight:hover {
    background-size: 100% 88%;
}
.adaptiread-tooltip {
    position: fixed;
    z-index: 1000000;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.15);
    padding: 16px;
    width: 280px;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 14px;
    color: #1a1a1b;
    border: 1px solid rgba(0,0,0,0.05);
    pointer-events: none;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.3s, transform 0.3s;
}
.adaptiread-tooltip.visible {
    opacity: 1;
    transform: translateY(0);
}
.adaptiread-tooltip .word {
    font-weight: 700;
    font-size: 18px;
    margin-bottom: 4px;
    color: #007bff;
    text-transform: capitalize;
}
.adaptiread-tooltip .pos {
    font-style: italic;
    color: #666;
    font-size: 12px;
    margin-bottom: 8px;
}
.adaptiread-tooltip .definition {
    line-height: 1.5;
    margin-bottom: 10px;
}
.adaptiread-tooltip .synonym {
    font-size: 12px;
    color: #00a86b;
    background: rgba(0, 168, 107, 0.1);
    padding: 2px 6px;
    border-radius: 4px;
    display: inline-block;
}
.adaptiread-loading {
    color: #999;
    font-size: 14px;
    font-style: italic;
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Ask to Simplify Popup */
.adaptiread-ask-popup {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    background: rgba(255, 255, 255, 0.98);
    backdrop-filter: blur(10px);
    border-radius: 16px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.15);
    padding: 16px 20px;
    width: 320px;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    border: 1px solid rgba(0,123,255,0.1);
    animation: adaptiread-slideInRight 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
}
@keyframes adaptiread-slideInRight {
    from { opacity: 0; transform: translateX(50px); }
    to { opacity: 1; transform: translateX(0); }
}
.adaptiread-ask-popup .title {
    font-weight: 700;
    font-size: 16px;
    color: #1a1a1b;
    margin-bottom: 4px;
}
.adaptiread-ask-popup .desc {
    font-size: 13px;
    color: #666;
    margin-bottom: 16px;
}
.adaptiread-ask-popup .actions {
    display: flex;
    gap: 10px;
}
.adaptiread-ask-popup button {
    flex: 1;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
}
.adaptiread-ask-popup .btn-yes {
    background: #007bff;
    color: white;
}
.adaptiread-ask-popup .btn-yes:hover { background: #0056b3; }
.adaptiread-ask-popup .btn-no {
    background: #f0f2f5 !important;
    color: #4b4b4b !important;
}
.adaptiread-ask-popup .btn-no:hover { background: #e4e6e9 !important; }

/* Global Loading Indicator */
.adaptiread-global-loading {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    background: white;
    padding: 12px 20px;
    border-radius: 50px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #007bff;
    border: 1px solid rgba(0,123,255,0.1);
    pointer-events: none;
}
.adaptiread-spinner {
    width: 20px;
    height: 20px;
    border: 3px solid rgba(0,123,255,0.1);
    border-top: 3px solid #007bff;
    border-radius: 50%;
    animation: adaptiread-spin 1s linear infinite;
}
@keyframes adaptiread-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
`;

function injectStyles() {
    try {
        if (!document.head) {
            console.log('AdaptiRead: Head not ready, waiting...');
            setTimeout(injectStyles, 100);
            return;
        }
        const styleUnits = document.createElement('style');
        styleUnits.textContent = TOOLTIP_CSS;
        document.head.appendChild(styleUnits);
        console.log('AdaptiRead: Styles injected');
    } catch (e) {
        console.error('AdaptiRead: Style injection failed', e);
    }
}

function safeSendMessage(message) {
    if (!chrome.runtime?.id) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(err => {
        if (!err.message.includes('Extension context invalidated')) {
            console.error('AdaptiRead Error:', err);
        }
        return null;
    });
}

chrome.storage.local.get(['enabled', 'simplifiedDomains'], (result) => {
    console.log('AdaptiRead: Settings loaded', result);
    isEnabled = result.enabled !== false;
    const simplifiedDomains = result.simplifiedDomains || [];
    const currentDomain = window.location.hostname;

    if (isEnabled && chrome.runtime?.id) {
        console.log('AdaptiRead: Initializing...');
        injectStyles();

        if (simplifiedDomains.includes(currentDomain)) {
            console.log('AdaptiRead: Auto-starting for domain:', currentDomain);
            startAdaptiRead();
        } else {
            showAskToSimplifyPopup();
        }
    } else {
        console.log('AdaptiRead: Disabled or ID missing');
    }
});

function showAskToSimplifyPopup() {
    if (hasScannedOnThisPage || document.getElementById('adaptiread-ask-popup')) return;

    const popup = document.createElement('div');
    popup.id = 'adaptiread-ask-popup';
    popup.className = 'adaptiread-ask-popup';
    popup.innerHTML = `
        <div class="title">✨ Simplify Reading?</div>
        <div class="desc">AdaptiRead can scan this page to highlight complex words and provide definitions.</div>
        <div class="actions">
            <button class="btn-yes">Yes, Simplify</button>
            <button class="btn-no">Not Now</button>
        </div>
    `;

    document.body.appendChild(popup);

    popup.querySelector('.btn-yes').addEventListener('click', () => {
        const currentDomain = window.location.hostname;
        chrome.storage.local.get(['simplifiedDomains'], (res) => {
            const list = res.simplifiedDomains || [];
            if (!list.includes(currentDomain)) {
                list.push(currentDomain);
                chrome.storage.local.set({ simplifiedDomains: list });
            }
        });
        popup.remove();
        startAdaptiRead();
    });

    popup.querySelector('.btn-no').addEventListener('click', () => {
        popup.remove();
    });

    // Auto-dismiss after 15 seconds if no interaction
    setTimeout(() => { if (popup.parentElement) popup.remove(); }, 15000);
}

function startAdaptiRead() {
    if (hasScannedOnThisPage) return;
    isScanningActive = true;
    debouncedScan();
    setupObserver();
}

function showLoadingIndicator() {
    if (globalLoadingIndicator) return;
    globalLoadingIndicator = document.createElement('div');
    globalLoadingIndicator.className = 'adaptiread-global-loading';
    globalLoadingIndicator.innerHTML = `
        <div class="adaptiread-spinner"></div>
        <span>Analyzing vocabulary...</span>
    `;
    document.body.appendChild(globalLoadingIndicator);
}

function hideLoadingIndicator() {
    if (globalLoadingIndicator) {
        globalLoadingIndicator.remove();
        globalLoadingIndicator = null;
    }
}

function setupObserver() {
    console.log('AdaptiRead: Setting up observer');
    const observer = new MutationObserver((mutations) => {
        if (!chrome.runtime?.id) { observer.disconnect(); return; }
        let shouldScan = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                const isOurNode = Array.from(mutation.addedNodes).some(n =>
                    n.classList?.contains('adaptiread-highlight') ||
                    n.classList?.contains('adaptiread-tooltip')
                );
                if (!isOurNode) { shouldScan = true; break; }
            }
        }
        if (shouldScan) debouncedScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
        if (chrome.runtime?.id) scanAndProcess();
    }, 800);
}

async function scanAndProcess() {
    if (!isEnabled || !chrome.runtime?.id || !isScanningActive) return;
    console.log('AdaptiRead: Scanning page...');
    showLoadingIndicator();
    let start = performance.now();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const blockMap = new Map();

    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || processedNodes.has(node)) continue;

        const tagName = parent.tagName;
        const forbidden = ['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE', 'INPUT', 'SELECT'];
        if (forbidden.includes(tagName) || parent.closest('.adaptiread-highlight')) continue;

        const blockParent = parent.closest('p, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, dt, dd, section, article, header, footer, main, aside') || parent;
        if (!blockMap.has(blockParent)) blockMap.set(blockParent, []);
        blockMap.get(blockParent).push(node);
    }
    console.log(`AdaptiRead: Collected ${blockMap.size} text blocks.`);

    if (blockMap.size === 0) {
        hideLoadingIndicator();
        return;
    }

    const textToAnalyzeSet = new Set();
    const blockToTextSegments = new Map();

    blockMap.forEach((nodes, blockElement) => {
        let fullText = blockElement.textContent.trim().replace(/\s+/g, ' ');
        if (fullText.length === 0) return;

        const segments = [];
        if (fullText.length > 2000) {
            const splitSentences = fullText.match(/[^.!?]+[.!?]?(?:\s|$)/g) || [fullText];
            splitSentences.forEach(s => {
                const trimmed = s.trim();
                if (trimmed.length > 0) segments.push(trimmed);
            });
        } else {
            segments.push(fullText);
        }

        blockToTextSegments.set(blockElement, segments);
        segments.forEach(seg => textToAnalyzeSet.add(seg));
    });

    const uniqueTexts = Array.from(textToAnalyzeSet);
    if (uniqueTexts.length === 0) {
        hideLoadingIndicator();
        return;
    }

    const analysisResults = await safeSendMessage({
        type: 'ANALYZE_PAGE',
        url: window.location.href,
        sentences: uniqueTexts
    });

    console.log(`AdaptiRead: Analysis received for ${uniqueTexts.length} segments in ${(performance.now() - start).toFixed(1)}ms`);

    if (!analysisResults) {
        hideLoadingIndicator();
        return;
    }

    // Normalize analysis results for robust lookup
    const normalizedAnalysis = {};
    Object.keys(analysisResults).forEach(key => {
        normalizedAnalysis[normalizeSentence(key)] = analysisResults[key];
    });

    blockMap.forEach((nodes, blockElement) => {
        const textSegments = blockToTextSegments.get(blockElement);
        if (!textSegments) return;

        const allComplexWords = new Set();
        textSegments.forEach(seg => {
            const normalizedSeg = normalizeSentence(seg);
            let words = normalizedAnalysis[normalizedSeg];
            if (words) {
                if (!Array.isArray(words)) words = Object.keys(words);
                words.forEach(w => allComplexWords.add(w));
            }
        });

        if (allComplexWords.size === 0) {
            const wasAnalyzed = textSegments.some(seg => normalizedAnalysis[normalizeSentence(seg)] !== undefined);
            if (wasAnalyzed) {
                nodes.forEach(n => processedNodes.add(n));
            }
            return;
        }

        const wordList = Array.from(allComplexWords).sort((a, b) => b.length - a.length);

        nodes.forEach(textNode => {
            if (processedNodes.has(textNode)) return;
            processedNodes.add(textNode);

            const textValue = textNode.nodeValue;
            let displaySegments = [{ type: 'text', content: textValue }];
            let changed = false;

            wordList.forEach(word => {
                const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
                const newDisplaySegments = [];

                displaySegments.forEach(segment => {
                    if (segment.type === 'text') {
                        let lastIndex = 0, match;
                        while ((match = regex.exec(segment.content)) !== null) {
                            changed = true;
                            if (match.index > lastIndex) {
                                newDisplaySegments.push({ type: 'text', content: segment.content.substring(lastIndex, match.index) });
                            }
                            newDisplaySegments.push({ type: 'complex', word: match[0] });
                            lastIndex = regex.lastIndex;
                        }
                        if (lastIndex < segment.content.length) {
                            newDisplaySegments.push({ type: 'text', content: segment.content.substring(lastIndex) });
                        }
                    } else {
                        newDisplaySegments.push(segment);
                    }
                });
                displaySegments = newDisplaySegments;
            });

            if (changed) {
                const fragment = document.createDocumentFragment();
                displaySegments.forEach(seg => {
                    if (seg.type === 'text') {
                        fragment.appendChild(document.createTextNode(seg.content));
                    } else {
                        const span = document.createElement('span');
                        span.className = 'adaptiread-highlight';
                        span.textContent = seg.word;
                        span.setAttribute('data-word', seg.word.toLowerCase());
                        fragment.appendChild(span);
                    }
                });
                if (textNode.parentNode) {
                    textNode.parentNode.replaceChild(fragment, textNode);
                }
            }
        });
    });

    hasScannedOnThisPage = true;
    hideLoadingIndicator();
}

// Tooltip Logic
document.addEventListener('mouseover', async (e) => {
    const target = e.target.closest('.adaptiread-highlight');
    if (!target || !chrome.runtime?.id) return;

    const word = target.getAttribute('data-word');
    showTooltip(target, word);
});

document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.adaptiread-highlight')) hideTooltip();
});

async function showTooltip(target, word) {
    if (activeTooltip) hideTooltip();

    activeTooltip = document.createElement('div');
    activeTooltip.className = 'adaptiread-tooltip';
    activeTooltip.innerHTML = `<div class="adaptiread-loading">Loading definition...</div>`;
    document.body.appendChild(activeTooltip);

    const rect = target.getBoundingClientRect();
    const tooltipWidth = 280;

    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    let left = rect.left + scrollLeft + (rect.width / 2) - (tooltipWidth / 2);
    let top = rect.top + scrollTop - 10;

    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth + scrollLeft - 10) left = window.innerWidth + scrollLeft - tooltipWidth - 10;

    activeTooltip.style.position = 'absolute';
    activeTooltip.style.top = `${top}px`;
    activeTooltip.style.left = `${left}px`;
    activeTooltip.style.transform = `translateY(-100%)`;

    requestAnimationFrame(() => {
        if (activeTooltip) activeTooltip.classList.add('visible');
    });

    const data = await safeSendMessage({ type: 'GET_DEFINITION', word });
    if (!chrome.runtime?.id || !activeTooltip) return;

    if (data) {
        activeTooltip.innerHTML = `
            <div class="word">${data.word}</div>
            <div class="pos">${data.partOfSpeech}</div>
            <div class="definition">${data.definition}</div>
            ${data.synonym ? `<div class="synonym">Synonym: ${data.synonym}</div>` : ''}
        `;
    } else {
        activeTooltip.innerHTML = `<div class="definition">Definition not found for "${word}".</div>`;
    }
}

function hideTooltip() {
    if (activeTooltip) {
        const el = activeTooltip;
        el.classList.remove('visible');
        setTimeout(() => el.remove(), 300);
        activeTooltip = null;
    }
}
