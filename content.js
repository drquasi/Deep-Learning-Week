let globalLoadingIndicator = null;
let hasScannedOnThisPage = false;
let isScanningActive = false;
let isApplyingHighlights = false;
let isEnabled = true;
let scanTimeout = null;
const processedNodes = new WeakSet();

// --- UTILS ---
function normalizeSentence(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
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

function injectStyles() {
    if (!document.head || document.getElementById('adaptiread-styles')) return;
    const style = document.createElement('style');
    style.id = 'adaptiread-styles';
    style.textContent = TOOLTIP_CSS;
    document.head.appendChild(style);
}

// --- UI COMPONENTS ---
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
        popup.remove();
        startAdaptiRead();
    });

    popup.querySelector('.btn-no').addEventListener('click', () => {
        hasScannedOnThisPage = true;
        popup.remove();
    });

    setTimeout(() => { if (popup.parentElement) popup.remove(); }, 15000);
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

// --- CORE LOGIC ---
function startAdaptiRead() {
    if (isScanningActive) return;
    console.log('AdaptiRead: Starting scanning engine...');
    hasScannedOnThisPage = true;
    isScanningActive = true;
    const existingPopup = document.getElementById('adaptiread-ask-popup');
    if (existingPopup) existingPopup.remove();

    injectStyles();
    scanAndProcess(true); // Initial LOUD scan
    setupObserver();
}

function setupObserver() {
    const observer = new MutationObserver((mutations) => {
        if (!chrome.runtime?.id || isApplyingHighlights || !isScanningActive) return;

        let shouldScan = false;
        for (const mutation of mutations) {
            // Ignore if mutation is inside our UI elements
            if (mutation.target.closest?.('.adaptiread-tooltip, .adaptiread-ask-popup, .adaptiread-global-loading')) continue;

            const hasNewContent = Array.from(mutation.addedNodes).some(n => {
                if (n.nodeType === Node.TEXT_NODE) return n.textContent.trim().length > 5;
                if (n.nodeType === Node.ELEMENT_NODE) {
                    const isOurs = n.classList.contains('adaptiread-highlight') ||
                        n.classList.contains('adaptiread-tooltip') ||
                        n.classList.contains('adaptiread-global-loading');
                    return !isOurs && !n.querySelector?.('.adaptiread-highlight');
                }
                return false;
            });

            if (hasNewContent) {
                shouldScan = true;
                break;
            }
        }
        if (shouldScan) {
            if (scanTimeout) clearTimeout(scanTimeout);
            scanTimeout = setTimeout(() => scanAndProcess(false), 1000); // Silent re-scan
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

async function scanAndProcess(isInitial = false) {
    if (isApplyingHighlights || !chrome.runtime?.id) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const blockMap = new Map();

    while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || processedNodes.has(node)) continue;
        if (parent.closest('.adaptiread-highlight, .adaptiread-tooltip, .adaptiread-ask-popup')) continue;

        const tagName = parent.tagName;
        const forbidden = ['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE', 'INPUT', 'SELECT'];
        if (forbidden.includes(tagName)) continue;

        const blockParent = parent.closest('p, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, dt, dd, section, article, header, footer, main, aside') || parent;
        if (!blockMap.has(blockParent)) blockMap.set(blockParent, []);
        blockMap.get(blockParent).push(node);
    }

    if (blockMap.size === 0) return;

    if (isInitial) showLoadingIndicator();
    isApplyingHighlights = true;

    try {
        const textToAnalyzeSet = new Set();
        const blockToTextSegments = new Map();

        blockMap.forEach((nodes, block) => {
            let fullText = block.textContent.trim().replace(/\s+/g, ' ');
            if (fullText.length === 0) return;

            const segments = fullText.length > 2000 ? (fullText.match(/[^.!?]+[.!?]?(?:\s|$)/g) || [fullText]) : [fullText];
            const validSegments = segments.map(s => s.trim()).filter(s => s.length > 0);

            blockToTextSegments.set(block, validSegments);
            validSegments.forEach(seg => textToAnalyzeSet.add(seg));
        });

        const uniqueTexts = Array.from(textToAnalyzeSet);
        if (uniqueTexts.length === 0) return;

        const analysis = await safeSendMessage({ type: 'ANALYZE_PAGE', url: window.location.href, sentences: uniqueTexts });
        if (!analysis) return;

        const normalizedAnalysis = {};
        Object.keys(analysis).forEach(k => normalizedAnalysis[normalizeSentence(k)] = analysis[k]);

        blockMap.forEach((nodes, block) => {
            const segments = blockToTextSegments.get(block);
            if (!segments) return;

            const words = new Set();
            segments.forEach(seg => {
                const results = normalizedAnalysis[normalizeSentence(seg)];
                if (results) (Array.isArray(results) ? results : Object.keys(results)).forEach(w => words.add(w));
            });

            if (words.size === 0) {
                nodes.forEach(n => processedNodes.add(n));
                return;
            }

            const sortedWords = Array.from(words).sort((a, b) => b.length - a.length);

            nodes.forEach(textNode => {
                if (processedNodes.has(textNode)) return;
                processedNodes.add(textNode);

                let displaySegments = [{ type: 'text', content: textNode.nodeValue }];
                let changed = false;

                sortedWords.forEach(word => {
                    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
                    let nextDisplaySegments = [];
                    displaySegments.forEach(seg => {
                        if (seg.type === 'text') {
                            let lastIndex = 0, match;
                            while ((match = regex.exec(seg.content)) !== null) {
                                changed = true;
                                if (match.index > lastIndex) nextDisplaySegments.push({ type: 'text', content: seg.content.substring(lastIndex, match.index) });
                                nextDisplaySegments.push({ type: 'complex', word: match[0] });
                                lastIndex = regex.lastIndex;
                            }
                            if (lastIndex < seg.content.length) nextDisplaySegments.push({ type: 'text', content: seg.content.substring(lastIndex) });
                        } else nextDisplaySegments.push(seg);
                    });
                    displaySegments = nextDisplaySegments;
                });

                if (changed) {
                    const fragment = document.createDocumentFragment();
                    displaySegments.forEach(seg => {
                        if (seg.type === 'text') {
                            const tn = document.createTextNode(seg.content);
                            processedNodes.add(tn);
                            fragment.appendChild(tn);
                        } else {
                            const span = document.createElement('span');
                            span.className = 'adaptiread-highlight';
                            span.textContent = seg.word;
                            span.setAttribute('data-word', seg.word.toLowerCase());
                            fragment.appendChild(span);
                        }
                    });
                    if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
                }
            });
        });
        attachIgnoreObserverToHighlights();
    } catch (err) {
        console.error('AdaptiRead: Scan error', err);
    } finally {
        isApplyingHighlights = false;
        hideLoadingIndicator();
    }
}

// --- INTERACTION LOGIC ---
let activeTooltip = null;

document.addEventListener('mouseover', async (e) => {
    const target = e.target.closest('.adaptiread-highlight');
    if (!target || !chrome.runtime?.id) return;

    if (activeTooltip && activeTooltip._target === target) return;

    const word = target.getAttribute('data-word');
    showTooltip(target, word);
    safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'hover' });
});

document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget?.closest?.('.adaptiread-tooltip, .adaptiread-highlight')) return;
    hideTooltip();
});

async function showTooltip(target, word) {
    if (activeTooltip) hideTooltip();
    activeTooltip = document.createElement('div');
    activeTooltip._target = target;
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
    activeTooltip.style.transform = 'translateY(-100%)';

    requestAnimationFrame(() => { if (activeTooltip) activeTooltip.classList.add('visible'); });

    const data = await safeSendMessage({ type: 'GET_DEFINITION', word });
    if (!activeTooltip || activeTooltip._target !== target) return;

    if (data) {
        activeTooltip.innerHTML = `
            <div class="word">${data.word}</div>
            <div class="pos">${data.partOfSpeech}</div>
            <div class="definition">${data.definition}</div>
            <div class="synonym">${data.synonym ? `Synonym: ${data.synonym}` : ''}</div>
            <div class="tutor-actions"><button class="btn-known" id="adaptiread-mark-known">I Already Know This</button></div>
        `;
        activeTooltip.querySelector('#adaptiread-mark-known').onclick = (e) => {
            e.stopPropagation();
            safeSendMessage({ type: 'MARK_KNOWN', word: data.word });
            target.classList.add('mastered');
            setTimeout(() => target.replaceWith(target.textContent), 500);
            hideTooltip();
        };
    } else {
        activeTooltip.innerHTML = `<div class="definition">Definition not found.</div>`;
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

// --- PASSIVE TRACKING ---
const trackedWordsOnPage = new Set();
const ignoreObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const word = entry.target.getAttribute('data-word');
            entry.target._viewTimer = setTimeout(() => {
                if (!trackedWordsOnPage.has(word)) {
                    trackedWordsOnPage.add(word);
                    safeSendMessage({ type: 'LOG_INTERACTION', word, interaction: 'context_seen' });
                }
            }, 3000);
        } else clearTimeout(entry.target._viewTimer);
    });
}, { threshold: 0.5 });

function attachIgnoreObserverToHighlights() {
    document.querySelectorAll('.adaptiread-highlight').forEach(el => ignoreObserver.observe(el));
}

// --- INIT ---
console.log('AdaptiRead: Content script loaded');
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_SIMPLIFY') {
        startAdaptiRead();
    }
});

chrome.storage.local.get(['enabled'], (res) => {
    isEnabled = res.enabled !== false;
    console.log('AdaptiRead: isEnabled =', isEnabled);
    if (isEnabled && chrome.runtime?.id) {
        injectStyles();
        showAskToSimplifyPopup();
    }
});

const TOOLTIP_CSS = `
    .adaptiread-highlight {
        background: linear-gradient(120deg, rgba(147, 51, 234, 0.15) 0%, rgba(79, 70, 229, 0.15) 100%);
        border-bottom: 2px solid rgba(147, 51, 234, 0.4);
        cursor: help;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        border-radius: 2px;
        padding: 0 1px;
    }
    .adaptiread-highlight:hover { background: rgba(147, 51, 234, 0.25); border-bottom-color: rgba(147, 51, 234, 0.8); }
    .adaptiread-tooltip {
        position: absolute; z-index: 2147483647; width: 280px; background: rgba(15, 15, 20, 0.95);
        backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px;
        padding: 16px; color: white; font-family: 'Inter', sans-serif; opacity: 0; visibility: hidden;
        transition: all 0.3s ease;
    }
    .adaptiread-tooltip.visible { opacity: 1; visibility: visible; }
    .adaptiread-tooltip .word { font-size: 18px; font-weight: 700; margin-bottom: 4px; font-family: 'Outfit', sans-serif; }
    .adaptiread-tooltip .pos { font-size: 11px; text-transform: uppercase; color: #9333ea; margin-bottom: 12px; }
    .adaptiread-tooltip .definition { font-size: 14px; line-height: 1.5; color: rgba(255, 255, 255, 0.8); margin-bottom: 12px; }
    .adaptiread-tooltip .btn-known { width: 100%; background: #9333ea; border: none; border-radius: 6px; padding: 8px; color: white; font-weight: 600; cursor: pointer; }
    .adaptiread-global-loading {
        position: fixed; top: 20px; right: 20px; z-index: 2147483647;
        background: rgba(15, 15, 20, 0.95); backdrop-filter: blur(12px);
        padding: 12px 20px; border-radius: 50px; border: 1px solid rgba(255, 255, 255, 0.1);
        color: white; display: flex; align-items: center; gap: 12px; font-size: 13px;
    }
    .adaptiread-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.1); border-top-color: #9333ea; border-radius: 50%; animation: adaptiread-spin 0.8s linear infinite; }
    @keyframes adaptiread-spin { to { transform: rotate(360deg); } }
    .adaptiread-ask-popup {
        position: fixed; top: 20px; right: 20px; z-index: 2147483647; width: 300px;
        background: rgba(15, 15, 20, 0.95); backdrop-filter: blur(12px); padding: 20px;
        border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); color: white;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5); font-family: 'Inter', sans-serif;
        animation: adaptiread-slide-in 0.4s ease-out;
    }
    @keyframes adaptiread-slide-in {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    .adaptiread-ask-popup .title { font-size: 16px; font-weight: 700; margin-bottom: 8px; font-family: 'Outfit', sans-serif; }
    .adaptiread-ask-popup .desc { font-size: 13px; color: rgba(255,255,255,0.7); margin-bottom: 16px; line-height: 1.4; }
    .adaptiread-ask-popup .actions { display: flex; gap: 10px; }
    .adaptiread-ask-popup button { flex: 1; padding: 10px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 12px; transition: all 0.2s; }
    .adaptiread-ask-popup .btn-yes { background: #9333ea; color: white; }
    .adaptiread-ask-popup .btn-no { background: rgba(255,255,255,0.1); color: white; }
`;
