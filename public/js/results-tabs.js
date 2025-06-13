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

            // Show/hide results based on selected tab
            const tabType = tab.dataset.tab;
            if (tabType === 'web') {
                webResults.style.display = 'flex';
                imageResults.style.display = 'none';
            } else if (tabType === 'images') {
                webResults.style.display = 'none';
                imageResults.style.display = 'grid';
            }
        });
    });
});
