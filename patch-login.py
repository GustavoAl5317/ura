import re

file_path = 'panel/index.html'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove login-overlay
content = re.sub(r'<div id="login-overlay".*?</div>\s*</div>\s*', '', content, flags=re.DOTALL)

# Remove checkLogin and doLogin JS functions
content = re.sub(r'function getKey\(\) \{.*?(?=// App Initialization after Login)', '', content, flags=re.DOTALL)

# Change DOMContentLoaded to call initializeApp directly
content = content.replace('checkLogin();', 'initializeApp();')

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Login removido')
