// Sidebar compartilhada — injetada em todas as páginas internas (após login).
// Ficar em um arquivo só evita duplicar o mesmo menu em 3+ páginas diferentes.
(function () {
  const paginaAtual = window.location.pathname;
  const ativa = (caminho) => (paginaAtual === caminho ? 'nav-item active' : 'nav-item');

  const iconeDashboard = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>';
  const iconeCasos = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
  const iconePagar = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L16 9.5"/></svg>';
  const iconeRelogio = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>';
  const iconeAlerta = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>';
  const iconeExportar = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';
  const iconeUpload = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/></svg>';

  const q = (status) => '/index.html?status=' + encodeURIComponent(status);
  // "Pagos"/"Cancelados" não vêm da coluna `status` (o motor nunca gera esses
  // valores) — vêm de `classificacao_pagamento`. `?classif=PAGO` na tela agrupa
  // "JÁ PAGO" (planilha) + "JÁ PAGO (comprovante)".
  const qc = (classif) => '/index.html?classif=' + encodeURIComponent(classif);

  document.getElementById('sidebar').innerHTML = `
    <div class="sidebar-brand">
      <div class="brand-owl">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="8" cy="11" r="4.2" fill="#0E1730"/><circle cx="16" cy="11" r="4.2" fill="#0E1730"/>
          <circle cx="8" cy="11" r="2.1" fill="#E0B15C"/><circle cx="16" cy="11" r="2.1" fill="#E0B15C"/>
          <path d="M12 14.5 L9.5 18 H14.5 Z" fill="#E0B15C"/>
        </svg>
      </div>
      <div class="brand-text"><span class="brand-wordmark">Caburé</span><span class="brand-sub">Sinistros</span></div>
      <button id="btn-recolher" class="btn-recolher" title="Recolher menu">‹</button>
    </div>

    <nav class="sidebar-nav">
      <a class="${ativa('/dashboard.html')}" href="/dashboard.html">${iconeDashboard}<span>Dashboard</span></a>

      <div class="nav-section">Operação</div>
      <a class="${ativa('/index.html')}" href="/index.html">${iconeCasos}<span>Todos os casos</span></a>
      <a class="${ativa('/pagar-agora.html')}" href="/pagar-agora.html">${iconePagar}<span>Pagar agora</span></a>
      <a class="${ativa('/lote.html')}" href="/lote.html">${iconeUpload}<span>Upload em lote</span></a>
      <a class="${ativa('/conferencia.html')}" href="/conferencia.html">${iconeAlerta}<span>Conferência manual</span></a>
      <a class="nav-item" href="${q('EM CARÊNCIA / ANÁLISE')}">${iconeRelogio}<span>Em análise</span></a>
      <a class="nav-item" href="${q('AGUARDANDO DOC')}">${iconeAlerta}<span>Pendentes</span></a>

      <div class="nav-section">Quem paga (interno)</div>
      <a class="nav-item" href="/por-cia.html?cia=MetLife">${iconePagar}<span>MetLife paga</span></a>
      <a class="nav-item" href="/por-cia.html?cia=Caburé">${iconePagar}<span>Caburé paga</span></a>

      <div class="nav-section">Encerrados</div>
      <a class="nav-item" href="${qc('PAGO')}"><span>Pagos</span></a>
      <a class="nav-item" href="${qc('CANCELADO')}"><span>Cancelados</span></a>
      <a class="nav-item" href="${q('NEGADO')}"><span>Negados</span></a>

      <div class="nav-section">Análises</div>
      <a class="${ativa('/exportar.html')}" href="/exportar.html">${iconeExportar}<span>Exportar Excel</span></a>
      <span class="nav-item disabled"><span>Relatórios</span><span class="nav-badge">em breve</span></span>

      <div class="nav-section">Configuração</div>
      <span class="nav-item disabled"><span>Regras</span><span class="nav-badge">em breve</span></span>
      <span class="nav-item disabled"><span>Usuários</span><span class="nav-badge">em breve</span></span>
    </nav>

    <div class="sidebar-footer"><a href="#" id="link-sair">Sair</a></div>
  `;

  document.getElementById('link-sair').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  const CHAVE_RECOLHIDA = 'cabure-sidebar-recolhida';
  if (localStorage.getItem(CHAVE_RECOLHIDA) === '1') {
    document.body.classList.add('sidebar-recolhida');
  }
  document.getElementById('btn-recolher').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-recolhida');
    localStorage.setItem(CHAVE_RECOLHIDA, document.body.classList.contains('sidebar-recolhida') ? '1' : '0');
  });
})();