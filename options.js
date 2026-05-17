const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');

const fields = ['gitlabBaseUrl', 'gitlabToken', 'gitlabProjects', 'jiraBaseUrl', 'jiraEmail', 'jiraToken', 'jiraPattern', 'defaultPatchPrefix'];

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    gitlabBaseUrl: '',
    gitlabToken: '',
    gitlabProjects: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraToken: '',
    jiraPattern: '[A-Z][A-Z0-9]+-\\d+',
    autoLookup: true,
    defaultPatchPrefix: 'p',
    mrDisplayMode: 'jira'
  });

  fields.forEach(f => {
    document.getElementById(f).value = settings[f];
  });
  document.getElementById('autoLookup').checked = settings.autoLookup;
  document.getElementById('mrDisplayMode').value = settings.mrDisplayMode;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {};
  fields.forEach(f => { data[f] = document.getElementById(f).value.trim(); });
  data.autoLookup = document.getElementById('autoLookup').checked;
  data.mrDisplayMode = document.getElementById('mrDisplayMode').value;

  await chrome.storage.sync.set(data);
  saveStatus.textContent = 'Saved!';
  setTimeout(() => { saveStatus.textContent = ''; }, 2000);
});

loadSettings();
