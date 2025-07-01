// Typewriter effect function
function typeWriter(element, text, delay = 50) {
    element.textContent = '';
    element.classList.add('typing');
    element.style.visibility = 'visible';

    return new Promise(resolve => {
        let i = 0;
        function type() {
            if (i < text.length) {
                const char = document.createElement('span');
                char.textContent = text[i];
                char.className = 'typewriter-char';
                element.appendChild(char);
                
                // Trigger reflow to enable animation
                char.offsetHeight;
                char.classList.add('visible');
                
                i++;
                setTimeout(type, delay);
            } else {
                element.classList.remove('typing');
                resolve();
            }
        }
        type();
    });
}

document.addEventListener('DOMContentLoaded', function() {
    const toggleBtn = document.querySelector('.toggle-panel');
    const webPanel = document.querySelector('.web-panel');
    const leftPanel = document.querySelector('.left-panel');
    const initialState = document.querySelector('.initial-state');
    const greetingBox = document.querySelector('.greeting-box');
    
    // Check if we have search results (web-panel has content)
    const hasSearchResults = webPanel && (
        webPanel.querySelector('.web-results-container') || 
        webPanel.querySelector('.search-result-item') || 
        webPanel.querySelector('.image-result-item')
    );
    
    // Check if we're in search results mode (body has search-active class or has results)
    if (document.body.classList.contains('search-active') || hasSearchResults) {
        // If we have search results, hide initial state and show greeting
        if (initialState) initialState.style.display = 'none';
        if (greetingBox) greetingBox.style.display = 'flex';
        
        // Add search-active class to body
        document.body.classList.add('search-active');
        
        // Start with uncollapsed panel
        if (webPanel) webPanel.classList.remove('collapsed');
        if (toggleBtn) toggleBtn.textContent = '▶';
    } else {
        // Initial state - hide greeting and show welcome screen
        if (greetingBox) greetingBox.style.display = 'none';
        if (initialState) initialState.style.display = 'flex';
        
        // Center the left panel
        if (webPanel) webPanel.classList.add('collapsed');
        if (toggleBtn) toggleBtn.textContent = '◀';
    }
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            // Toggle the collapsed state
            if (webPanel) webPanel.classList.toggle('collapsed');
            
            // Update button icon
            this.textContent = webPanel && webPanel.classList.contains('collapsed') ? '◀' : '▶';
        });
    }

    // Form submission handling
    const searchForm = document.querySelector('form');
    if (searchForm) {
        searchForm.addEventListener('submit', function(e) {
            e.preventDefault(); // Prevent immediate form submission
            
            // Hide initial state
            if (initialState) initialState.style.display = 'none';
            
            // Get query and show greeting box
            const queryInput = this.querySelector('#queryInput');
            if (queryInput && greetingBox) {
                const queryText = queryInput.value;
                greetingBox.style.display = 'flex';
                const greetingText = greetingBox.querySelector('p');
                if (greetingText) greetingText.textContent = queryText; // Set query text
                
                // Show greeting box with fade-in animation
                setTimeout(() => {
                    greetingBox.style.opacity = '1';
                    
                    // Wait a bit to show the greeting, then submit
                    setTimeout(() => {
                        document.body.classList.add('loading');
                        document.body.classList.add('search-active');
                        searchForm.submit(); // Actually submit the form to /search
                    }, 1000);
                }, 300);
            }

            // Show the web panel if it's collapsed
            if (webPanel) webPanel.classList.remove('collapsed');
            if (toggleBtn) toggleBtn.textContent = '▶';
            
            // Add loading class to show terminal
            document.body.classList.add('loading');
            document.body.classList.add('search-active');
            
            // Clear previous terminal content
            const terminal = document.getElementById('terminal-content');
            if (terminal) {
                terminal.innerHTML = '';
                
                // Add initial terminal messages
                const queryValue = queryInput ? queryInput.value : 'query';
                addTerminalLine(`$ Processing query: "${queryValue}"`);
                addTerminalLine('$ Initiating search pipeline...');
                
                // Show processing stages with timing
                setTimeout(() => addTerminalLine('$ [1/4] Connecting to SerpAPI...'), 500);
                setTimeout(() => addTerminalLine('$ [2/4] Fetching search results and images...'), 1500);
                setTimeout(() => addTerminalLine('$ [3/4] Processing data with OpenAI...'), 3000);
                setTimeout(() => addTerminalLine('$ [4/4] Formatting response...'), 4000);
                
                // Add blinking cursor
                setTimeout(() => addTerminalLine('_', true), 4100);
            }
        });
    }

    function addTerminalLine(text, isCursor = false) {
        const terminal = document.getElementById('terminal-content');
        if (terminal) {
            const line = document.createElement('div');
            line.className = 'terminal-line' + (isCursor ? ' blink' : '');
            terminal.appendChild(line);
            terminal.scrollTop = terminal.scrollHeight;
            // Use typeWriter for typewriter effect
            if (!isCursor) {
                typeWriter(line, text, 15); // 15ms per character for a smooth effect
            } else {
                line.textContent = text;
            }
        }
    }
});
