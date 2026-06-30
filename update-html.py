import re

file_path = 'panel/index.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add Login Overlay inside <body>
login_html = '''
  <div id="login-overlay" style="position: fixed; inset: 0; background: var(--bg); z-index: 99999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);">
    <div class="panel-card" style="padding: 2.5rem; width: 100%; max-width: 400px; text-align: center; border: 1px solid var(--accent); box-shadow: 0 0 40px rgba(59, 130, 246, 0.2);">
      <div class="header-logo" style="margin-bottom: 2rem; justify-content: center;">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 12 2.1 7.1"/></svg>
        </div>
        <div>URA <span style="color: var(--accent);">AI</span></div>
      </div>
      <h3 style="margin-bottom: 0.5rem;">Acesso Restrito</h3>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">Por favor, informe a senha de acesso (Admin API Key).</p>
      
      <div class="form-group" style="text-align: left;">
        <input type="password" id="login-pwd" class="form-textarea" placeholder="Sua senha..." style="height: 48px; border-radius: var(--radius-sm);" onkeydown="if(event.key === 'Enter') doLogin()" />
      </div>
      
      <button class="primary" onclick="doLogin()" style="width: 100%; justify-content: center; padding: 1rem; font-size: 1rem; border-radius: var(--radius-sm);">
        Acessar Painel
      </button>
      <div id="login-error" style="color: var(--danger); font-size: 0.85rem; margin-top: 1rem; display: none;">Senha incorreta ou sem permissão.</div>
    </div>
  </div>
  
  <div id="sidebar-overlay" class="sidebar-overlay" onclick="toggleSidebar()"></div>
'''
if 'id="login-overlay"' not in content:
    content = content.replace('<body>', '<body>\n' + login_html)

# 2. Add Sidebar Overlay CSS
sidebar_css = '''
    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 80; backdrop-filter: blur(4px); transition: opacity 0.3s; opacity: 0; }
    .sidebar-overlay.show { display: block; opacity: 1; }
    
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
      .sidebar.open { transform: translateX(0); }
      .content-wrapper { margin-left: 0; padding: 1rem; }
      .mobile-menu-btn { display: block !important; }
      .top-metrics { grid-template-columns: 1fr; }
      .chart-grid { grid-template-columns: 1fr; }
      .table-container { overflow-x: auto; }
      #event-modal .panel-body > div.form-group { margin-bottom: 1rem !important; }
    }
'''
if '.sidebar-overlay {' not in content:
    # replace the @media (max-width: 768px) block entirely
    content = re.sub(r'@media \(max-width: 768px\) \{.*?(?=\n\s*</style>)', sidebar_css.strip(), content, flags=re.DOTALL)


# 3. Add Auditoria Tab to Sidebar
nav_auditoria = '''
          <button class="nav-item" onclick="switchTab('audit', this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Auditoria OpenAI
          </button>
'''
if "switchTab('audit'" not in content:
    content = content.replace('</nav>', nav_auditoria + '        </nav>')

# 4. Add Auditoria Tab Content
audit_tab = '''
      <!-- Audit Tab -->
      <main id="tab-audit" class="tab-pane">
        <div class="toolbar">
          <span class="toolbar-label">Histórico de Auditoria OpenAI</span>
          <button class="ghost" onclick="loadAudit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 1 0 2.6-6.4L2 9"/></svg>
            Atualizar
          </button>
        </div>
        
        <div class="panel-card auto-height">
          <div class="panel-head">
            <h3>Acessos e Chaves</h3>
            <span class="hint">Últimos eventos na conta OpenAI</span>
          </div>
          <div class="panel-body table-container">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Data / Hora</th>
                  <th>Tipo de Evento</th>
                  <th>Usuário</th>
                  <th>IP de Origem</th>
                  <th>Detalhes</th>
                </tr>
              </thead>
              <tbody id="audit-tbody">
                <tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">Carregando...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
'''
if 'id="tab-audit"' not in content:
    content = content.replace('<!-- Events Tab -->', audit_tab + '\n      <!-- Events Tab -->')

# 5. Add JS Logic for Login and Audit
js_logic = '''
    // Login Logic
    function getKey() {
      return localStorage.getItem('ura_admin_key') || '';
    }
    
    function saveKey(key) {
      localStorage.setItem('ura_admin_key', key);
    }
    
    async function checkLogin() {
      const key = getKey();
      if (!key) {
        document.getElementById('login-overlay').style.display = 'flex';
        return;
      }
      
      try {
        const res = await fetch('/api/health', { headers: { 'Authorization': 'Bearer ' + key }});
        if (res.ok) {
          document.getElementById('login-overlay').style.display = 'none';
          initializeApp();
        } else {
          document.getElementById('login-overlay').style.display = 'flex';
          document.getElementById('login-error').style.display = 'block';
        }
      } catch (err) {
        // block
      }
    }
    
    async function doLogin() {
      const pwd = document.getElementById('login-pwd').value;
      if (!pwd) return;
      saveKey(pwd);
      document.getElementById('login-error').style.display = 'none';
      await checkLogin();
    }

    // App Initialization after Login
    function initializeApp() {
      loadState();
      loadSessions();
      loadEvent(); // load events
      loadAudit();
      startPoll();
    }

    // Wait for DOM
    document.addEventListener("DOMContentLoaded", () => {
      checkLogin();
    });

    // Fix sidebar logic
    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebar-overlay').classList.toggle('show');
    }

    // Audit Tab Logic
    async function loadAudit() {
      try {
        const data = await api('/api/openai/audit/history');
        const tbody = document.getElementById('audit-tbody');
        if (!data.history || data.history.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;">Nenhum evento registrado.</td></tr>';
          return;
        }
        
        tbody.innerHTML = data.history.map(e => {
          const date = new Date(e.effective_at * 1000).toLocaleString('pt-BR');
          const actor = e.actor?.session?.user?.email || e.actor?.api_key?.user?.email || '-';
          const ip = e.actor?.session?.ip_address || '-';
          const err = e['login.failed']?.error_message || '';
          
          let tipoHtml = e.type;
          if (e.type === 'login.succeeded') tipoHtml = '<span style="color:var(--ok)">Login (Sucesso)</span>';
          if (e.type === 'login.failed') tipoHtml = '<span style="color:var(--danger)">Login (Falha)</span>';
          if (e.type === 'api_key.created') tipoHtml = '<span style="color:var(--warn)">API Key Criada</span>';
          if (e.type === 'api_key.deleted') tipoHtml = '<span style="color:var(--warn)">API Key Deletada</span>';

          return `
            <tr>
              <td style="font-family:var(--mono);font-size:0.85rem;">${date}</td>
              <td>${tipoHtml}</td>
              <td>${actor}</td>
              <td style="font-family:var(--mono);font-size:0.85rem;">${ip}</td>
              <td style="font-family:var(--mono);font-size:0.85rem;color:var(--danger);">${err}</td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        console.error(err);
      }
    }
'''

content = re.sub(r'function getKey\(\) \{.*?(?=\n    async function loadState)', '', content, flags=re.DOTALL)
content = re.sub(r'loadState\(\);\s*loadSessions\(\);\s*startPoll\(\);', '', content)

if 'function doLogin()' not in content:
    content = content.replace('// UI Tab Switcher', js_logic + '\n    // UI Tab Switcher')

if "if (tabId === 'audit') loadAudit();" not in content:
    content = content.replace("if (tabId === 'events') {", "if (tabId === 'audit') loadAudit();\n      if (tabId === 'events') {")

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Patch aplicado com sucesso')
