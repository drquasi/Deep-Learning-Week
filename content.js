// AdaptiRead Content Script - Automated Wipe & Reverse Hover
let isEnabled = true;
let isAutoSimplify = false;

chrome.storage.local.get(['enabled', 'autoSimplify'], (result) => {
    isEnabled = result.enabled !== false;
    isAutoSimplify = result.autoSimplify === true;
    if (isEnabled) {
        scanAndProcess();
    }
});

chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled || changes.autoSimplify) {
        location.reload(); // Simplest way to re-apply logic
    }
});

const COMPLEX_WORDS = {
    "bank": { "synonym": "bank", "definition": "Check context for meaning." },
    "gregarious": { "synonym": "sociable", "definition": "Fond of company; sociable." },
    "legislation": { "synonym": "laws", "definition": "Laws, considered collectively." },
    "accelerate": { "synonym": "speed up", "definition": "Begin to move more quickly." },
    "melancholy": { "synonym": "sad", "definition": "A feeling of pensive sadness." },
    "substantial": { "synonym": "large", "definition": "Of considerable importance, size, or worth." },
    "photosynthesis": { "synonym": "energy making", "definition": "The process by which plants make food." },
    "ubiquitous": { "synonym": "everywhere", "definition": "Present, appearing, or found everywhere." },
    "capricious": { "synonym": "unpredictable", "definition": "Given to sudden and unaccountable mood changes." },
    "mitigate": { "synonym": "reduce", "definition": "Make less severe, serious, or painful." }
};

function scanAndProcess() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const nodesToProcess = [];

    while (node = walker.nextNode()) {
        if (node.parentElement.tagName !== 'SCRIPT' && node.parentElement.tagName !== 'STYLE' && node.parentElement.tagName !== 'TEXTAREA') {
            nodesToProcess.push(node);
        }
    }

    let wordsFound = 0;

    nodesToProcess.forEach(textNode => {
        const text = textNode.nodeValue;
        let newHTML = text;
        let found = false;

        Object.keys(COMPLEX_WORDS).forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            if (regex.test(text)) {
                found = true;
                const info = COMPLEX_WORDS[word.toLowerCase()];

                if (isAutoSimplify) {
                    // Automated Wipe Replacement Mode
                    newHTML = newHTML.replace(regex, (match) => `
                        <span class="adaptiread-wrapper" data-original="${match}" data-word="${word.toLowerCase()}">
                            <span class="adaptiread-original">${match}</span>
                            <span class="adaptiread-simplified">${info.synonym}</span>
                        </span>
                    `);
                } else {
                    // Manual Highlight Mode
                    newHTML = newHTML.replace(regex, `<span class="adaptiread-highlight" data-word="${word.toLowerCase()}">${word}</span>`);
                }
                wordsFound++;
            }
        });

        if (found) {
            const span = document.createElement('span');
            span.innerHTML = newHTML;
            textNode.parentNode.replaceChild(span, textNode);
        }
    });

    if (isAutoSimplify) {
        // Trigger wipe animation
        setTimeout(() => {
            document.querySelectorAll('.adaptiread-wrapper').forEach(el => {
                el.classList.add('active');
                chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', interaction: 'simplify', word: el.getAttribute('data-word') });
            });
        }, 300);
    }

    addListeners();
}

function addListeners() {
    // Mode-specific listeners
    if (isAutoSimplify) {
        document.querySelectorAll('.adaptiread-wrapper').forEach(el => {
            let hoverStartTime;
            el.addEventListener('mouseenter', () => {
                hoverStartTime = Date.now();
                const word = el.getAttribute('data-word');
                const original = el.getAttribute('data-original');
                const info = COMPLEX_WORDS[word];
                showTooltip(el, { synonym: original, definition: info.definition }, true);
            });
            el.addEventListener('mouseleave', () => {
                if (hoverStartTime) logHover(el.getAttribute('data-word'), Date.now() - hoverStartTime);
                hideTooltip();
            });
        });
    } else {
        document.querySelectorAll('.adaptiread-highlight').forEach(el => {
            let hoverStartTime;
            el.addEventListener('mouseenter', () => {
                hoverStartTime = Date.now();
                const word = el.getAttribute('data-word');
                showTooltip(el, COMPLEX_WORDS[word], false);
            });
            el.addEventListener('mouseleave', () => {
                if (hoverStartTime) logHover(el.getAttribute('data-word'), Date.now() - hoverStartTime);
                hideTooltip();
            });
            el.addEventListener('click', async () => {
                const word = el.getAttribute('data-word');
                const context = el.parentElement.innerText;
                const simplified = await chrome.runtime.sendMessage({ type: 'GET_SIMPLIFICATION', word, context });
                if (simplified) {
                    el.innerText = simplified;
                    el.style.color = '#00e5ff';
                    el.style.fontWeight = '700';
                    chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', interaction: 'simplify', word });
                }
            });
        });
    }
}

function logHover(word, duration) {
    const type = duration > 5000 ? 'hover_long' : 'hover_short';
    chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', interaction: type, word });
}

function showTooltip(target, info, isReverse) {
    hideTooltip();
    const tooltip = document.createElement('div');
    tooltip.className = 'adaptiread-tooltip';

    tooltip.innerHTML = `
        <strong>${isReverse ? 'Original Word' : 'Definition'}</strong>
        <span class="synonym">${isReverse ? info.synonym : info.synonym}</span>
        <p class="definition">${info.definition}</p>
        <button class="know-btn">I Know This</button>
    `;

    document.body.appendChild(tooltip);
    const rect = target.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
    tooltip.style.top = `${rect.top + window.scrollY - 10}px`;

    tooltip.querySelector('.know-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'LOG_INTERACTION', interaction: 'know_this', word: target.getAttribute('data-word') });
        if (isReverse) {
            target.classList.remove('active');
            target.querySelector('.adaptiread-simplified').style.display = 'none';
            target.querySelector('.adaptiread-original').style.opacity = '1';
            target.querySelector('.adaptiread-original').style.transform = 'none';
        } else {
            target.classList.remove('adaptiread-highlight');
        }
        hideTooltip();
    });
}

function hideTooltip() {
    const t = document.querySelector('.adaptiread-tooltip');
    if (t) t.remove();
}
