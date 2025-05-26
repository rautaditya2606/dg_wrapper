document.addEventListener('DOMContentLoaded', function() {
    const toggleBtn = document.querySelector('.toggle-panel');
    const rightPanel = document.querySelector('.right-panel');
    const leftPanel = document.querySelector('.left-panel');
    
    // Check if we're in search results mode (body has search-active class)
    if (document.body.classList.contains('search-active')) {
        // If we have search results, start with uncollapsed panel
        rightPanel.classList.remove('collapsed');
        toggleBtn.textContent = '▶';
    } else {
        // Initial state - center the left panel
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
        // Show the right panel if it's collapsed
        rightPanel.classList.remove('collapsed');
        toggleBtn.textContent = '▶';
        
        // Add loading class to show terminal
        document.body.classList.add('loading');
        
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
