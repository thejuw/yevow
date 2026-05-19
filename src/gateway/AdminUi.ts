export function adminUiResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Sovereign-Sigma Command Center</title>
  <style>
    body{margin:0;background:#0e1014;color:#f3efe7;font:14px/1.45 Inter,system-ui,sans-serif}
    header{padding:28px 36px;border-bottom:1px solid #2a2f39}
    h1{font-family:Bodoni 72,Didot,serif;font-size:38px;margin:0;letter-spacing:0}
    main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;padding:24px 36px}
    section{border:1px solid #2a2f39;padding:18px;background:#151922}
    h2{margin:0 0 14px;font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#d8c596}
    label{display:grid;gap:6px;margin:12px 0;color:#bfc7d5}
    input,select,button{font:inherit;background:#0e1014;color:#f3efe7;border:1px solid #3b4352;padding:10px}
    button{cursor:pointer;background:#d8c596;color:#111317;border:0}
    pre{white-space:pre-wrap;min-height:160px;background:#090b0f;padding:14px;color:#79f2c0}
  </style>
</head>
<body>
  <header><h1>Sovereign-Sigma</h1></header>
  <main>
    <section>
      <h2>Risk Command Center</h2>
      <label>JWT <input id="token" type="password" placeholder="Bearer token" /></label>
      <label>Trading Enabled <select id="TRADING_ENABLED"><option value="false">false</option><option value="true">true</option></select></label>
      <label>Max Position Size <input id="MAX_POSITION_SIZE" type="number" step="0.0001" /></label>
      <label>Kelly Fraction <input id="KELLY_FRACTION" type="number" min="0" max="1" step="0.01" /></label>
      <label>Min EV Threshold <input id="MIN_EV_THRESHOLD" type="number" step="0.0001" /></label>
      <label>Max Latency MS <input id="LATENCY_THRESHOLD_MS" type="number" min="1" step="1" /></label>
      <button onclick="saveConfig()">Save</button>
    </section>
    <section>
      <h2>Credential Vault</h2>
      <label>Key <select id="vaultKey"><option>HL_AGENT_ADDRESS</option><option>HL_AGENT_SECRET</option><option>EXCHANGE_API_KEY</option><option>EXCHANGE_API_SECRET</option></select></label>
      <label>Secret <input id="vaultSecret" type="password" /></label>
      <button onclick="rotateVault()">Rotate</button>
      <button onclick="testVault()">Test Connection</button>
    </section>
    <section>
      <h2>Time Machine</h2>
      <label>Mode <select id="engineMode"><option>LIVE</option><option>PAPER</option></select></label>
      <label>From <input id="dateFrom" type="datetime-local" /></label>
      <label>To <input id="dateTo" type="datetime-local" /></label>
      <button onclick="startReplay()">Replay</button>
      <progress id="replayProgress" value="0" max="100"></progress>
    </section>
    <section>
      <h2>Agent CCTV</h2>
      <button onclick="loadTrace()">Refresh Trace</button>
      <pre id="output"></pre>
    </section>
  </main>
  <script>
    const out = document.getElementById('output');
    const auth = () => ({Authorization:'Bearer '+document.getElementById('token').value,'content-type':'application/json'});
    async function saveConfig(){
      if(!confirm('Apply high-impact risk settings?')) return;
      const body={confirmHighImpact:true,config:{TRADING_ENABLED:document.getElementById('TRADING_ENABLED').value==='true',MAX_POSITION_SIZE:+MAX_POSITION_SIZE.value,KELLY_FRACTION:+KELLY_FRACTION.value,MIN_EV_THRESHOLD:+MIN_EV_THRESHOLD.value,LATENCY_THRESHOLD_MS:+LATENCY_THRESHOLD_MS.value}};
      out.textContent=await (await fetch('/admin/config',{method:'POST',headers:auth(),body:JSON.stringify(body)})).text();
    }
    async function rotateVault(){out.textContent=await (await fetch('/admin/vault',{method:'POST',headers:auth(),body:JSON.stringify({keyName:vaultKey.value,secret:vaultSecret.value,rotationReason:'ui-rotation'})})).text();}
    async function testVault(){out.textContent=await (await fetch('/admin/vault/test',{method:'POST',headers:auth()})).text();}
    async function startReplay(){out.textContent=await (await fetch('/admin/replay',{method:'POST',headers:auth(),body:JSON.stringify({dateFrom:dateFrom.value,dateTo:dateTo.value,shadowBankroll:100000,speedMultiplier:20})})).text(); await replayStatus();}
    async function replayStatus(){const s=await (await fetch('/admin/replay/status',{headers:auth()})).json(); replayProgress.value=s.replay?.progressPct||0; return s;}
    async function loadTrace(){out.textContent=JSON.stringify(await (await fetch('/admin/trace',{headers:auth()})).json(),null,2);}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}
