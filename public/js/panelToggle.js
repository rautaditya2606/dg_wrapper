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
    const rightPanel = document.querySelector('.right-panel');
    const leftPanel = document.querySelector('.left-panel');
    const initialState = document.querySelector('.initial-state');
    const greetingBox = document.querySelector('.greeting-box');
    
    // Check if we're in search results mode (body has search-active class)
    if (document.body.classList.contains('search-active')) {
        // If we have search results, hide initial state and show greeting
        initialState.style.display = 'none';
        greetingBox.style.display = 'flex';
        // Start with uncollapsed panel
        rightPanel.classList.remove('collapsed');
        toggleBtn.textContent = '▶';
    } else {
        // Initial state - hide greeting and show welcome screen
        greetingBox.style.display = 'none';
        initialState.style.display = 'flex';
        // Center the left panel
        rightPanel.classList.add('collapsed');
        toggleBtn.textContent = '◀';
    }
    
    toggleBtn.addEventListener('click', function() {
        // Toggle the collapsed state
        rightPanel.classList.toggle('collapsed');
        
        // Update button icon
        this.textContent = rightPanel.classList.contains('collapsed') ? '◀' : '▶';
    });

    // Form submission handling
    const searchForm = document.querySelector('form');
    searchForm.addEventListener('submit', function(e) {
        e.preventDefault(); // Prevent immediate form submission
        
        // Hide initial state
        initialState.style.display = 'none';
        
        // Get query and show greeting box
        const queryText = this.querySelector('input[name="query"]').value;
        greetingBox.style.display = 'flex';
        const greetingText = greetingBox.querySelector('p');
        greetingText.textContent = queryText; // Set query text
        
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

        // Show the right panel if it's collapsed
        rightPanel.classList.remove('collapsed');
        toggleBtn.textContent = '▶';
        
        // Add loading class to show terminal
        document.body.classList.add('loading');
        document.body.classList.add('search-active');
        
        // Clear previous terminal content
        const terminal = document.getElementById('terminal-content');
        if (terminal) {
            terminal.innerHTML = '';
            
            // Add initial terminal messages
            addTerminalLine(`$ Processing query: "${this.querySelector('input[name="query"]').value}"`);
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

    function addTerminalLine(text, isCursor = false) {
        const terminal = document.getElementById('terminal-content');
        if (terminal) {
            const line = document.createElement('div');
            line.className = 'terminal-line' + (isCursor ? ' blink' : '');
            line.textContent = text;
            terminal.appendChild(line);
            terminal.scrollTop = terminal.scrollHeight;
        }
    }
});
