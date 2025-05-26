document.addEventListener('DOMContentLoaded', function() {
    const toggleBtn = document.querySelector('.toggle-panel');
    const rightPanel = document.querySelector('.right-panel');
    
    toggleBtn.addEventListener('click', function() {
        rightPanel.classList.toggle('collapsed');
        
        // Update button icon
        this.textContent = rightPanel.classList.contains('collapsed') ? '◀' : '▶';
    });
});
