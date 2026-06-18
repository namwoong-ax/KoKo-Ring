// ════════════════════════════════════════════════════════════
//  코코링 케어 — 시설 관리 대시보드
//  코코링 본체(index.html)와 같은 Firebase 프로젝트를 사용하되,
//  완전히 분리된 별도 화면/파일로 운영함 (사용자도 디자인도 다르므로)
// ════════════════════════════════════════════════════════════

// 본체(index.html)와 동일한 Firebase 프로젝트
const firebaseConfig = {
  apiKey: "AIzaSyCfdMxQx7NqYz5eyblUhR_nOVwxPUZNnYM",
  authDomain: "koko-ring.firebaseapp.com",
  projectId: "koko-ring",
  storageBucket: "koko-ring.firebasestorage.app",
  messagingSenderId: "656069841928",
  appId: "1:656069841928:web:d48d48de8e11da09b26dbd",
};
firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();

let currentUser = null;
let currentFacilityId = null;
let currentStaffRole = null; // 'admin' | 'staff'
let roomLinksCache = [];     // 이 시설에 연결된(approved) 호실 목록
let reportsCache = {};       // familyId -> 오늘 리포트 (없으면 가장 최근 리포트)
let activeFilter = 'all';

// ── 인증 흐름 ───────────────────────────────────────────────
// 주소 끝에 ?logout을 붙이고 들어오면, 화면을 그리기도 전에 강제로 로그아웃부터
// 처리함. 이전 로그인이 자동으로 남아있어 로그인 화면 자체가 안 뜨고 바로
// 다른 화면으로 튕겨나가는 경우, 사용자가 직접 확실하게 빠져나올 방법이 필요해서 추가함.
if (window.location.search.includes('logout')) {
  fbAuth.signOut().then(() => {
    window.location.href = window.location.pathname; // ?logout 떼고 깨끗하게 다시 로드
  });
} else {
  fbAuth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (!user) {
      show('login-screen');
      return;
    }
    await loadStaffStatus();
  });
}

async function loadStaffStatus() {
  try {
    // 이 사용자가 속한 facilityStaff 문서를 찾음 (uid로 조회)
    const snap = await fbDb.collection('facilityStaff').where('uid', '==', currentUser.uid).limit(1).get();
    if (snap.empty) {
      // 가입 절차를 안 거친 로그인 사용자 — 가입 화면으로
      showSignup();
      return;
    }
    const staff = snap.docs[0].data();
    currentFacilityId = staff.facilityId;
    currentStaffRole = staff.role;

    if (staff.status !== 'approved') {
      document.getElementById('pending-desc').textContent =
        staff.role === 'admin'
          ? '시설 등록 승인을 기다리고 있어요. 운영팀이 확인 후 이용하실 수 있어요.'
          : '관리자가 가입을 승인하면 대시보드를 이용할 수 있어요. 승인 후 다시 로그인해주세요.';
      show('pending-screen');
      return;
    }

    const facSnap = await fbDb.collection('facilities').doc(currentFacilityId).get();
    const facName = facSnap.exists ? facSnap.data().name : '시설';
    document.getElementById('facility-name-label').textContent = facName;

    // staff 권한이면 "직원 관리" 탭은 안 보이게 (관리자만 직원을 승인/관리)
    if (currentStaffRole !== 'admin') {
      const staffNav = document.querySelector('[data-tab="staff"]');
      if (staffNav) staffNav.style.display = 'none';
    }

    show('app');
    document.getElementById('today-date').textContent = formatTodayKorean();
    await loadRoomData();
  } catch (e) {
    console.error('직원 상태 확인 실패:', e);
    alert('로그인 정보를 확인하는 중 문제가 생겼어요. 다시 시도해주세요.');
  }
}

function show(id) {
  ['login-screen', 'pending-screen', 'app'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === id) { el.classList.remove('hidden'); el.style.display = (s === 'app') ? 'flex' : 'flex'; }
    else { el.classList.add('hidden'); el.style.display = 'none'; }
  });
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-pw').value;
  const errBox = document.getElementById('login-err');
  errBox.style.display = 'none';
  if (!email || !pw) { errBox.textContent = '이메일과 비밀번호를 입력해주세요.'; errBox.style.display = 'block'; return; }
  try {
    await fbAuth.signInWithEmailAndPassword(email, pw);
  } catch (e) {
    errBox.textContent = '로그인에 실패했어요. 이메일과 비밀번호를 확인해주세요.';
    errBox.style.display = 'block';
  }
}

function doLogout() {
  fbAuth.signOut();
  currentFacilityId = null;
  currentStaffRole = null;
}

// 가입 흐름(신규 시설 등록 vs 기존 시설 직원으로 합류)은 별도 화면(signup.html)에서 처리.
// 로그인했지만 아직 facilityStaff 문서가 없는 사용자는 그 화면으로 보냄.
function showSignup() {
  window.location.href = 'signup.html';
}

// ── 날짜 유틸 ───────────────────────────────────────────────
function formatTodayKorean() {
  const d = new Date();
  const days = ['일','월','화','수','목','금','토'];
  return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── 호실 데이터 로딩 ────────────────────────────────────────
async function loadRoomData() {
  document.getElementById('room-table-body').innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--gray); padding:40px;">불러오는 중...</td></tr>`;
  try {
    // 1) 이 시설에 승인된(approved) 연결만 가져옴 — 보호자 동의 없는 연결은 절대 안 보임
    const linkSnap = await fbDb.collection('roomLinks')
      .where('facilityId', '==', currentFacilityId)
      .where('status', '==', 'approved')
      .get();
    roomLinksCache = linkSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (roomLinksCache.length === 0) {
      reportsCache = {};
      renderRoomTable();
      return;
    }

    // 2) 연결된 각 가족의 가장 최근 리포트(오늘 것이 있으면 오늘 것)를 가져옴
    // (where + orderBy 조합은 Firestore 복합 색인이 미리 있어야 하는데, 그게
    //  없으면 쿼리가 에러로 실패함. 색인을 따로 안 만들어도 되게, orderBy 없이
    //  where만 쓰고 정렬은 받아온 다음 자바스크립트에서 직접 처리함.)
    reportsCache = {};
    await Promise.all(roomLinksCache.map(async (link) => {
      try {
        const repSnap = await fbDb.collection('reports')
          .where('familyId', '==', link.familyId)
          .limit(20)
          .get();
        const docs = repSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => (b.생성시각 || 0) - (a.생성시각 || 0));
        reportsCache[link.familyId] = docs.slice(0, 5);
      } catch (e) {
        console.error('리포트 로드 실패 (familyId=' + link.familyId + '):', e);
        reportsCache[link.familyId] = [];
      }
    }));

    renderRoomTable();
  } catch (e) {
    console.error('호실 데이터 로드 실패:', e);
    document.getElementById('room-table-body').innerHTML =
      `<tr><td colspan="6" style="text-align:center; color:var(--danger); padding:40px;">데이터를 불러오지 못했어요. 새로고침해주세요.</td></tr>`;
  }
}

// 위험신호 판정 — 코코링 본체(index.html)의 renderAnalysisTab()과 동일한 원칙을 따름:
// 1회성 신호와 반복 패턴을 구분해서, 우연한 한 번의 결과로 과도한 경보를 띄우지 않음.
function evaluateRoom(reports) {
  if (!reports || reports.length === 0) {
    return { level: 'none', label: '통화 기록 없음', todayDetections: [], patternNote: null, todayReport: null };
  }
  const today = todayStr();
  const todayReport = reports.find(r => r.날짜 === today) || null;

  // 오늘 통화에서 감지된 내용 (1회성이라도 AI가 실제 판단한 거라 그대로 보여줌)
  const todayDetections = [];
  if (todayReport) {
    if (todayReport.위험신호 && todayReport.위험신호 !== '없음') {
      todayDetections.push({ level: 'danger', text: todayReport.위험신호 });
    }
    if (todayReport.요약) {
      todayDetections.push({ level: 'info', text: todayReport.요약 });
    }
  }

  // 최근 5회 중 반복 패턴 (코코링 본체와 동일 기준: 2회 이상 반복 시에만 의미있는 신호)
  const recent5 = reports.slice(0, 5);
  const memConcernCount = recent5.filter(r => {
    const cog = r.인지평가 || {};
    return cog.단기기억 === '주의' || cog.단기기억 === '확인필요';
  }).length;
  const dangerSignalCount = recent5.filter(r => r.위험신호 && r.위험신호 !== '없음').length;

  let patternNote = null;
  let level = 'ok';
  let label = '정상';

  if (dangerSignalCount >= 1 && todayReport && todayReport.위험신호 && todayReport.위험신호 !== '없음') {
    level = 'danger';
    label = '위험';
  } else if (memConcernCount >= 2) {
    level = 'warn';
    label = '주의';
    patternNote = `최근 통화 ${recent5.length}회 중 ${memConcernCount}회에서 단어 회상 지연 반복`;
  } else if (!todayReport) {
    level = 'none';
    label = '오늘 통화 없음';
  }

  return { level, label, todayDetections, patternNote, todayReport };
}

// ── 표 렌더링 ───────────────────────────────────────────────
function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
  renderRoomTable();
}

function renderRoomTable() {
  const search = (document.getElementById('room-search').value || '').trim().toLowerCase();
  const rows = roomLinksCache.map(link => {
    const reports = reportsCache[link.familyId] || [];
    const ev = evaluateRoom(reports);
    return { link, ev };
  }).filter(({ link, ev }) => {
    if (activeFilter !== 'all' && ev.level !== activeFilter) return false;
    if (search) {
      const hay = (link.roomNumber + ' ' + link.elderName).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => (a.link.roomNumber || '').localeCompare(b.link.roomNumber || '', 'ko'));

  // 요약 카드
  const dangerCount = roomLinksCache.filter(l => evaluateRoom(reportsCache[l.familyId]).level === 'danger').length;
  const warnCount = roomLinksCache.filter(l => evaluateRoom(reportsCache[l.familyId]).level === 'warn').length;
  document.getElementById('summary-row').innerHTML = `
    <div class="summary-card"><div class="summary-num">${roomLinksCache.length}</div><div class="summary-label">연결된 호실</div></div>
    <div class="summary-card danger"><div class="summary-num">${dangerCount}</div><div class="summary-label">위험 신호</div></div>
    <div class="summary-card warn"><div class="summary-num">${warnCount}</div><div class="summary-label">주의 필요</div></div>
  `;

  const tbody = document.getElementById('room-table-body');
  const emptyEl = document.getElementById('room-empty');
  if (roomLinksCache.length === 0) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--gray); padding:40px;">조건에 맞는 호실이 없어요.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(({ link, ev }) => {
    const pillClass = ev.level === 'danger' ? 'danger' : ev.level === 'warn' ? 'warn' : ev.level === 'ok' ? 'ok' : 'none';
    const todayCallText = ev.todayReport
      ? `${ev.todayReport.시간 || ''} 통화 완료`
      : `<span style="color:var(--gray)">통화 없음</span>`;
    const detectHtml = ev.todayDetections.length > 0
      ? ev.todayDetections.map(d => `<div class="detect-text">${escHtmlLocal(d.text)}</div>`).join('')
      : `<div class="detect-empty">특이 감지 없음</div>`;
    const patternHtml = ev.patternNote
      ? `<div class="detect-text">⚠️ ${escHtmlLocal(ev.patternNote)}</div>`
      : `<div class="detect-empty">-</div>`;
    const journalHtml = ev.todayReport
      ? `<button class="btn-journal" onclick="openJournal('${link.familyId}','${link.id}')">일지 보기</button>`
      : `<span class="detect-empty">-</span>`;

    return `<tr>
      <td>
        <div class="room-cell">${escHtmlLocal(link.roomNumber)}</div>
        <div class="name-cell">${escHtmlLocal(link.elderName)}<div class="name-sub">${escHtmlLocal((ev.todayReport && ev.todayReport.이름) || '')}</div></div>
      </td>
      <td>${todayCallText}</td>
      <td><span class="status-pill ${pillClass}">${ev.label}</span></td>
      <td>${detectHtml}</td>
      <td>${patternHtml}</td>
      <td>${journalHtml}</td>
    </tr>`;
  }).join('');
}

function escHtmlLocal(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── 일지 모달 ───────────────────────────────────────────────
function openJournal(familyId, linkId) {
  const reports = reportsCache[familyId] || [];
  const today = todayStr();
  const r = reports.find(x => x.날짜 === today);
  const link = roomLinksCache.find(l => l.id === linkId);
  if (!r) return;

  document.getElementById('journal-title').textContent = `${link ? link.roomNumber + ' ' : ''}${r.이름 || ''} 어르신 — 오늘의 일지`;
  document.getElementById('journal-sub').textContent = `${r.날짜} ${r.시간 || ''} 통화 기록 기반 자동 생성`;

  // 통화 브리핑(요약, 감정, 위험신호)을 요양원 업무 일지 형식으로 그대로 재구성.
  // AI를 또 호출하지 않고, 이미 저장된 브리핑 필드를 일지 문장 형식으로 조립함
  // (코코링 본체에서 통화 종료 시 이미 한 번 AI 분석을 거친 결과를 재사용 —
  //  같은 내용으로 매번 다시 AI를 부르면 비용도 늘고 느려지므로)
  const lines = [];
  lines.push(`[정서 상태] ${r.감정 || '평가 안 됨'}`);
  if (r.요약) lines.push(`[금일 대화 요약] ${r.요약}`);
  if (r.위험신호 && r.위험신호 !== '없음') lines.push(`[감지된 위험신호] ${r.위험신호}`);
  if (Array.isArray(r.주요내용) && r.주요내용.length > 0) {
    lines.push(`[주요 발언]`);
    r.주요내용.forEach(t => lines.push(`  · ${t}`));
  }
  if (r.인지평가) {
    const cog = r.인지평가;
    const parts = [];
    if (cog.시간인지) parts.push(`시간인지: ${cog.시간인지}`);
    if (cog.장소인지) parts.push(`장소인지: ${cog.장소인지}`);
    if (cog.단기기억) parts.push(`단기기억: ${cog.단기기억}`);
    if (cog.계산) parts.push(`계산: ${cog.계산}`);
    if (cog.실행추론) parts.push(`실행추론: ${cog.실행추론}`);
    if (parts.length) lines.push(`[인지 평가] ${parts.join(' / ')}`);
  }
  lines.push('');
  lines.push('※ 이 일지는 코코링 AI 통화 내용을 기반으로 자동 생성되었으며, 실제 대면 관찰 및 전문의 평가를 대체하지 않습니다.');

  document.getElementById('journal-content').textContent = lines.join('\n');
  document.getElementById('journal-modal').classList.add('show');
}
function closeJournalModal() {
  document.getElementById('journal-modal').classList.remove('show');
}

// ── 탭 전환 ─────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const tab = item.dataset.tab;
    ['rooms', 'staff', 'links'].forEach(t => {
      document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
    });
    if (tab === 'staff') loadStaffTab();
    if (tab === 'links') loadLinksTab();
  });
});

// ── 직원 관리 탭 ────────────────────────────────────────────
async function loadStaffTab() {
  const tbody = document.getElementById('staff-table-body');
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--gray); padding:40px;">불러오는 중...</td></tr>`;

  // 시설 코드 표시 — 관리자만 재발급 가능, 직원은 보기만 가능
  try {
    const facSnap = await fbDb.collection('facilities').doc(currentFacilityId).get();
    document.getElementById('facility-code-text').textContent = facSnap.exists ? (facSnap.data().facilityCode || '------') : '------';
  } catch (e) {
    console.error('시설 코드 로드 실패:', e);
  }
  const regenBtn = document.getElementById('regen-code-btn');
  if (regenBtn) regenBtn.style.display = (currentStaffRole === 'admin') ? '' : 'none';

  try {
    const snap = await fbDb.collection('facilityStaff').where('facilityId', '==', currentFacilityId).get();
    const staffList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const emptyEl = document.getElementById('staff-empty');
    if (staffList.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.innerHTML = staffList.map(s => {
      const statusPill = s.status === 'approved'
        ? `<span class="status-pill ok">승인됨</span>`
        : `<span class="status-pill warn">승인 대기</span>`;
      const actionBtn = (currentStaffRole === 'admin' && s.status !== 'approved' && s.uid !== currentUser.uid)
        ? `<button class="btn-journal" onclick="approveStaff('${s.id}')">승인하기</button>`
        : '';
      return `<tr>
        <td class="name-cell">${escHtmlLocal(s.name || '이름 없음')}</td>
        <td>${escHtmlLocal(s.email || '')}</td>
        <td>${s.role === 'admin' ? '관리자' : '직원'}</td>
        <td>${statusPill}</td>
        <td>${actionBtn}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error('직원 목록 로드 실패:', e);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:40px;">불러오지 못했어요.</td></tr>`;
  }
}

async function approveStaff(staffDocId) {
  if (!confirm('이 직원의 가입을 승인할까요?')) return;
  try {
    await fbDb.collection('facilityStaff').doc(staffDocId).update({ status: 'approved', approvedAt: Date.now() });
    await loadStaffTab();
  } catch (e) {
    console.error('승인 실패:', e);
    alert('승인 처리에 실패했어요.');
  }
}

// 시설 코드 재발급 — 가족 코드(genFamilyCode)와 동일하게 헷갈리는 0/O/1/I를
// 제외한 6글자 무작위 코드를 만들고, 다른 시설이 이미 쓰고 있지 않은지 확인함.
// 재발급하면 기존 코드는 즉시 무효화되므로, 그 코드로 합류를 시도하던 직원이
// 있다면 새 코드를 다시 전달받아야 함 — 그 점을 확인 문구에 명시함.
function genFacilityCodeLocal() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function regenerateFacilityCode() {
  if (currentStaffRole !== 'admin') { alert('코드 재발급은 관리자만 할 수 있어요.'); return; }
  if (!confirm('시설 코드를 새로 발급할까요? 기존 코드는 더 이상 사용할 수 없게 돼요. 합류를 기다리는 직원이 있다면 새 코드를 다시 전달해주세요.')) return;

  const btn = document.getElementById('regen-code-btn');
  if (btn) { btn.disabled = true; btn.textContent = '발급 중...'; }
  try {
    let code = genFacilityCodeLocal();
    for (let i = 0; i < 5; i++) {
      const dup = await fbDb.collection('facilities').where('facilityCode', '==', code).limit(1).get();
      if (dup.empty) break;
      code = genFacilityCodeLocal();
    }
    await fbDb.collection('facilities').doc(currentFacilityId).update({ facilityCode: code, codeUpdatedAt: Date.now() });
    document.getElementById('facility-code-text').textContent = code;
    alert(`새 시설 코드가 발급됐어요: ${code}`);
  } catch (e) {
    console.error('시설 코드 재발급 실패:', e);
    alert('코드 재발급에 실패했어요.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '코드 재발급'; }
  }
}

// ── 호실 연결 관리 탭 ───────────────────────────────────────
async function loadLinksTab() {
  const tbody = document.getElementById('links-table-body');
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--gray); padding:40px;">불러오는 중...</td></tr>`;
  try {
    const snap = await fbDb.collection('roomLinks').where('facilityId', '==', currentFacilityId).get();
    const links = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
    const emptyEl = document.getElementById('links-empty');
    if (links.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.innerHTML = links.map(l => {
      const statusPill = l.status === 'approved' ? `<span class="status-pill ok">연결됨</span>`
        : l.status === 'rejected' ? `<span class="status-pill danger">거절됨</span>`
        : `<span class="status-pill warn">보호자 동의 대기</span>`;
      const dateStr = l.requestedAt ? new Date(l.requestedAt).toLocaleDateString('ko-KR') : '-';
      const delBtn = `<button class="btn-journal" onclick="deleteLink('${l.id}')">삭제</button>`;
      return `<tr>
        <td class="name-cell">${escHtmlLocal(l.roomNumber)} <span class="name-sub">${escHtmlLocal(l.elderName||'')}</span></td>
        <td style="font-weight:700; letter-spacing:1px;">${escHtmlLocal(l.linkCode)}</td>
        <td>${statusPill}</td>
        <td>${dateStr}</td>
        <td>${delBtn}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error('연결 목록 로드 실패:', e);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:40px;">불러오지 못했어요.</td></tr>`;
  }
}

function openCreateLinkModal() {
  document.getElementById('link-room-number').value = '';
  document.getElementById('link-elder-name').value = '';
  document.getElementById('create-link-modal').classList.add('show');
}
function closeCreateLinkModal() {
  document.getElementById('create-link-modal').classList.remove('show');
}

function genLinkCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동되는 0/O, 1/I 제외
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createRoomLink() {
  const roomNumber = document.getElementById('link-room-number').value.trim();
  const elderName = document.getElementById('link-elder-name').value.trim();
  if (!roomNumber || !elderName) { alert('호실 번호와 어르신 성함을 입력해주세요.'); return; }
  try {
    // 문서 ID를 자동생성 대신 코드 자체로 씀 — 보호자가 코드를 입력하면 where 쿼리 없이
    // doc(코드)로 바로 정확한 문서를 찾을 수 있고, 보안 규칙에서도 정확한 ID로 검증 가능해짐.
    let code = genLinkCode();
    for (let i = 0; i < 5; i++) {
      const dup = await fbDb.collection('roomLinks').doc(code).get();
      if (!dup.exists) break;
      code = genLinkCode();
    }
    await fbDb.collection('roomLinks').doc(code).set({
      facilityId: currentFacilityId,
      roomNumber, elderName,
      linkCode: code,
      familyId: null,       // 보호자가 코드 입력 후 동의하면 채워짐
      status: 'pending',
      requestedAt: Date.now(),
      createdBy: currentUser.uid,
    });
    closeCreateLinkModal();
    await loadLinksTab();
    alert(`연결 코드가 발급됐어요: ${code}\n\n이 코드를 보호자에게 전달해주세요. 보호자가 코코링 앱에서 이 코드를 입력하고 동의하면 연결이 완료돼요.`);
  } catch (e) {
    console.error('연결 코드 발급 실패:', e);
    alert('연결 코드 발급에 실패했어요.');
  }
}

async function deleteLink(linkId) {
  if (!confirm('이 연결을 삭제할까요? 이미 연결된 경우 보호자 쪽에서도 연결이 끊어져요.')) return;
  try {
    await fbDb.collection('roomLinks').doc(linkId).delete();
    await loadLinksTab();
  } catch (e) {
    console.error('연결 삭제 실패:', e);
    alert('삭제에 실패했어요.');
  }
}
