import re

file_path = 'panel/index.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove onclick="toggleSidebar()" from everywhere
content = content.replace('onclick="toggleSidebar()"', '')

# Replace @media (max-width: 768px) CSS
mobile_css = '''
    @media (max-width: 768px) {
      .app-layout { flex-direction: column; }
      .sidebar { position: static; width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); padding-bottom: 0; }
      .nav-menu { flex-direction: row; overflow-x: auto; padding: 0.5rem 1rem; gap: 0.5rem; align-items: center; white-space: nowrap; }
      .nav-item { padding: 0.6rem 1rem; font-size: 0.85rem; }
      .sidebar-overlay { display: none !important; }
      .mobile-menu-btn { display: none !important; }
      .content-wrapper { margin-left: 0; padding: 1rem; }
      .top-metrics { grid-template-columns: 1fr; }
      .chart-grid { grid-template-columns: 1fr; }
      .table-container { overflow-x: auto; }
      #event-modal .panel-body > div.form-group { margin-bottom: 1rem !important; }
    }
'''

content = re.sub(r'@media \(max-width: 768px\) \{.*?(?=\n\s*</style>)', mobile_css.strip(), content, flags=re.DOTALL)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Patch aplicado')
