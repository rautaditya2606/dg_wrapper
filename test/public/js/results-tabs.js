document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.tab');
    const webResults = document.getElementById('web-results');
    const imageResults = document.getElementById('image-results');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            
            // Add active class to clicked tab
            tab.classList.add('active');
            
            // Show/hide appropriate content
            if (tab.dataset.tab === 'web') {
                webResults.style.display = 'block';
                imageResults.style.display = 'none';
            } else {
                webResults.style.display = 'none';
                imageResults.style.display = 'block';
            }
        });
    });

    // Handle panel toggle
    const toggleButton = document.querySelector('.toggle-panel');
    const leftPanel = document.querySelector('.left-panel');
    const rightPanel = document.querySelector('.right-panel');
    let isLeftPanelVisible = true;

    if (toggleButton) {
        toggleButton.addEventListener('click', () => {
            isLeftPanelVisible = !isLeftPanelVisible;
            leftPanel.style.display = isLeftPanelVisible ? 'block' : 'none';
            rightPanel.style.flex = isLeftPanelVisible ? '0.4' : '1';
            toggleButton.textContent = isLeftPanelVisible ? '◀' : '▶';
        });
    }
}); 