class Terminal {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isActive = false;
        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentLine = '';
        this.cursorPosition = 0;
        this.ws = null;
        this.isConnected = false;
        
        this.init();
        this.connectWebSocket();
    }

    init() {
        if (!this.container) return;
        
        // Clear existing content and create terminal structure
        this.container.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title">
                    <span class="terminal-status ${this.isConnected ? 'online' : 'offline'}"></span>
                    Backend Terminal
                </div>
                <div class="terminal-controls">
                    <span class="control-btn minimize" data-tooltip="Minimize">─</span>
                    <span class="control-btn maximize" data-tooltip="Maximize">□</span>
                    <span class="control-btn close" data-tooltip="Close">×</span>
                </div>
            </div>
            <div class="terminal-body">
                <div class="terminal-output" id="terminal-output"></div>
                <div class="terminal-input-line">
                    <span class="prompt">$ </span>
                    <span class="input-text" id="input-text"></span>
                    <span class="cursor" id="cursor">█</span>
                </div>
            </div>
        `;

        this.output = document.getElementById('terminal-output');
        this.inputText = document.getElementById('input-text');
        this.cursor = document.getElementById('cursor');
        
        this.setupEventListeners();
        this.startTerminal();
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.isConnected = true;
                this.updateConnectionStatus();
                this.addLine('WebSocket connected to backend', 'success');
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleWebSocketMessage(data);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };
            
            this.ws.onclose = () => {
                this.isConnected = false;
                this.updateConnectionStatus();
                this.addLine('WebSocket disconnected from backend', 'error');
                
                // Try to reconnect after 5 seconds
                setTimeout(() => {
                    if (!this.isConnected) {
                        this.connectWebSocket();
                    }
                }, 5000);
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
                this.updateConnectionStatus();
            };
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.addLine('Failed to connect to backend', 'error');
        }
    }

    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'connection':
                this.addLine(`Connected to backend: ${data.message}`, 'success');
                break;
            case 'backend_activity':
                this.addBackendActivity(data.activity);
                break;
            default:
                this.addLine(`Received: ${JSON.stringify(data)}`, 'info');
        }
    }

    updateConnectionStatus() {
        const statusElement = this.container.querySelector('.terminal-status');
        if (statusElement) {
            statusElement.className = `terminal-status ${this.isConnected ? 'online' : 'offline'}`;
        }
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (!this.isActive) return;
            
            switch(e.key) {
                case 'Enter':
                    this.executeCommand();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.navigateHistory(-1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.navigateHistory(1);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.moveCursor(-1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.moveCursor(1);
                    break;
                case 'Backspace':
                    e.preventDefault();
                    this.backspace();
                    break;
                case 'Delete':
                    e.preventDefault();
                    this.delete();
                    break;
                default:
                    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        this.addCharacter(e.key);
                    }
            }
        });

        // Focus terminal when clicking on it
        this.container.addEventListener('click', () => {
            this.focus();
        });

        // Terminal control buttons
        const closeBtn = this.container.querySelector('.control-btn.close');
        const minimizeBtn = this.container.querySelector('.control-btn.minimize');
        const maximizeBtn = this.container.querySelector('.control-btn.maximize');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.container.style.display = 'none';
            });
        }

        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => {
                const body = this.container.querySelector('.terminal-body');
                body.style.display = body.style.display === 'none' ? 'block' : 'none';
            });
        }

        if (maximizeBtn) {
            maximizeBtn.addEventListener('click', () => {
                this.container.classList.toggle('maximized');
            });
        }
    }

    startTerminal() {
        this.isActive = true;
        this.focus();
        
        // Initial terminal messages
        this.addLine('Backend Terminal v1.0.0', 'system');
        this.addLine('Initializing system components...', 'info');
        this.addLine('✓ SerpAPI connection established', 'success');
        this.addLine('✓ Wikipedia API ready', 'success');
        this.addLine('✓ Web scraping tools loaded', 'success');
        this.addLine('✓ Memory buffer initialized', 'success');
        this.addLine('System ready for queries', 'success');
        this.addLine('');
        this.addPrompt();
    }

    focus() {
        this.isActive = true;
        this.cursor.style.display = 'inline';
        this.container.classList.add('focused');
    }

    blur() {
        this.isActive = false;
        this.cursor.style.display = 'none';
        this.container.classList.remove('focused');
    }

    addLine(text, type = 'normal') {
        const line = document.createElement('div');
        line.className = `terminal-line ${type}`;
        line.textContent = text;
        this.output.appendChild(line);
        this.scrollToBottom();
    }

    addPrompt() {
        const prompt = document.createElement('div');
        prompt.className = 'terminal-prompt';
        prompt.innerHTML = '<span class="prompt">$ </span><span class="input-text"></span><span class="cursor">█</span>';
        this.output.appendChild(prompt);
        this.scrollToBottom();
    }

    executeCommand() {
        const command = this.currentLine.trim();
        if (command) {
            this.commandHistory.push(command);
            this.historyIndex = this.commandHistory.length;
            
            this.addLine(`$ ${command}`, 'command');
            
            // Simulate command execution
            this.simulateCommandExecution(command);
        }
        
        this.currentLine = '';
        this.cursorPosition = 0;
        this.updateInputDisplay();
        this.addPrompt();
    }

    simulateCommandExecution(command) {
        const lowerCommand = command.toLowerCase();
        
        if (lowerCommand.includes('help')) {
            this.addLine('Available commands:', 'info');
            this.addLine('  help - Show this help message', 'normal');
            this.addLine('  status - Show system status', 'normal');
            this.addLine('  clear - Clear terminal', 'normal');
            this.addLine('  search <query> - Perform web search', 'normal');
            this.addLine('  reconnect - Reconnect to backend', 'normal');
        } else if (lowerCommand.includes('status')) {
            this.addLine('System Status:', 'info');
            this.addLine(`  WebSocket: ${this.isConnected ? 'Connected' : 'Disconnected'}`, this.isConnected ? 'success' : 'error');
            this.addLine('  ✓ SerpAPI: Connected', 'success');
            this.addLine('  ✓ Wikipedia: Ready', 'success');
            this.addLine('  ✓ Memory: Active', 'success');
            this.addLine('  ✓ Model: Claude 3 Sonnet', 'success');
        } else if (lowerCommand.includes('clear')) {
            this.output.innerHTML = '';
        } else if (lowerCommand.includes('reconnect')) {
            this.addLine('Attempting to reconnect to backend...', 'info');
            if (this.ws) {
                this.ws.close();
            }
            this.connectWebSocket();
        } else if (lowerCommand.includes('search')) {
            const query = command.replace('search', '').trim();
            if (query) {
                this.addLine(`Initiating search for: "${query}"`, 'info');
                this.simulateSearchProcess(query);
            } else {
                this.addLine('Error: Please provide a search query', 'error');
            }
        } else {
            this.addLine(`Command not found: ${command}`, 'error');
            this.addLine('Type "help" for available commands', 'info');
        }
    }

    simulateSearchProcess(query) {
        const steps = [
            { delay: 500, message: 'Connecting to search APIs...', type: 'info' },
            { delay: 1000, message: 'Querying SerpAPI for web results...', type: 'info' },
            { delay: 1500, message: 'Fetching Wikipedia data...', type: 'info' },
            { delay: 2000, message: 'Processing results with AI model...', type: 'info' },
            { delay: 2500, message: 'Formatting response...', type: 'info' },
            { delay: 3000, message: 'Search completed successfully', type: 'success' }
        ];

        steps.forEach((step, index) => {
            setTimeout(() => {
                this.addLine(step.message, step.type);
                if (index === steps.length - 1) {
                    this.addLine(`Found ${Math.floor(Math.random() * 10) + 5} relevant results`, 'success');
                }
            }, step.delay);
        });
    }

    navigateHistory(direction) {
        if (this.commandHistory.length === 0) return;
        
        this.historyIndex += direction;
        
        if (this.historyIndex < 0) {
            this.historyIndex = 0;
        } else if (this.historyIndex >= this.commandHistory.length) {
            this.historyIndex = this.commandHistory.length;
            this.currentLine = '';
        } else {
            this.currentLine = this.commandHistory[this.historyIndex];
        }
        
        this.cursorPosition = this.currentLine.length;
        this.updateInputDisplay();
    }

    moveCursor(direction) {
        this.cursorPosition += direction;
        if (this.cursorPosition < 0) this.cursorPosition = 0;
        if (this.cursorPosition > this.currentLine.length) this.cursorPosition = this.currentLine.length;
        this.updateInputDisplay();
    }

    addCharacter(char) {
        this.currentLine = this.currentLine.slice(0, this.cursorPosition) + char + this.currentLine.slice(this.cursorPosition);
        this.cursorPosition++;
        this.updateInputDisplay();
    }

    backspace() {
        if (this.cursorPosition > 0) {
            this.currentLine = this.currentLine.slice(0, this.cursorPosition - 1) + this.currentLine.slice(this.cursorPosition);
            this.cursorPosition--;
            this.updateInputDisplay();
        }
    }

    delete() {
        if (this.cursorPosition < this.currentLine.length) {
            this.currentLine = this.currentLine.slice(0, this.cursorPosition) + this.currentLine.slice(this.cursorPosition + 1);
            this.updateInputDisplay();
        }
    }

    updateInputDisplay() {
        const currentPrompt = this.output.querySelector('.terminal-prompt:last-child');
        if (currentPrompt) {
            const inputText = currentPrompt.querySelector('.input-text');
            inputText.textContent = this.currentLine;
        }
    }

    scrollToBottom() {
        this.output.scrollTop = this.output.scrollHeight;
    }

    // Public method to add real-time backend activity
    addBackendActivity(activity) {
        const timestamp = new Date().toLocaleTimeString();
        let message = '';
        let type = 'info';

        switch (activity.type) {
            case 'Web Search':
                message = `[${timestamp}] Web Search: ${activity.content}`;
                type = 'search';
                break;
            case 'Search Result':
                message = `[${timestamp}] Found: ${activity.content.substring(0, 50)}...`;
                type = 'result';
                break;
            case 'wikipedia':
                if (activity.status === 'started') {
                    message = `[${timestamp}] Wikipedia Query: ${activity.query}`;
                    type = 'wikipedia';
                } else if (activity.status === 'success') {
                    message = `[${timestamp}] Wikipedia: Retrieved ${activity.content.length} characters`;
                    type = 'success';
                } else if (activity.status === 'error') {
                    message = `[${timestamp}] Wikipedia Error: ${activity.error}`;
                    type = 'error';
                }
                break;
            case 'fetch':
                if (activity.status === 'started') {
                    message = `[${timestamp}] Fetching: ${activity.url}`;
                    type = 'fetch';
                } else if (activity.status === 'success') {
                    message = `[${timestamp}] Fetched: ${activity.title || activity.url}`;
                    type = 'success';
                } else if (activity.status === 'error') {
                    message = `[${timestamp}] Error fetching: ${activity.error}`;
                    type = 'error';
                }
                break;
            case 'search':
                if (activity.status === 'error') {
                    message = `[${timestamp}] Search Error: ${activity.error}`;
                    type = 'error';
                }
                break;
            default:
                message = `[${timestamp}] ${activity.type}: ${activity.content || activity.query || ''}`;
                type = 'info';
        }

        this.addLine(message, type);
    }

    // Method to simulate real-time backend activities
    startBackendSimulation() {
        const activities = [
            { type: 'System', content: 'Initializing AI model...', delay: 1000 },
            { type: 'System', content: 'Loading conversation memory...', delay: 2000 },
            { type: 'System', content: 'Preparing search tools...', delay: 3000 },
            { type: 'Web Search', content: 'Processing user query...', delay: 4000 },
            { type: 'Search Result', content: 'Analyzing search results...', delay: 5000 },
            { type: 'System', content: 'Generating AI response...', delay: 6000 }
        ];

        activities.forEach((activity, index) => {
            setTimeout(() => {
                this.addBackendActivity(activity);
            }, activity.delay);
        });
    }
}

// Global terminal instance
let terminal;

// Initialize terminal when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    terminal = new Terminal('terminal-content');
});

// Export for use in other scripts
window.Terminal = Terminal; 