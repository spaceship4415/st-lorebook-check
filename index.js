// 로어북 점검: 모든 로어북을 훑어 '켜 놨는데 실제로는 프롬프트에 안 들어가는' 엔트리를 찾는다.
// 1) 출구 점검: 엔트리 위치에 맞는 출구가 지금 프리셋·채팅에서 열려 있는지
//    - 아웃렛: 프리셋에 {{outlet::이름}} 이 있는지 (반대로 프리셋에만 있고 엔트리가 없는 아웃렛도)
//    - ↑Char/↓Char: World Info (before/after) 마커 프롬프트가 켜져 있는지
//    - ↑EM/↓EM: 예시 대화 마커가 켜져 있고 '예시 대화 안 넣기'가 꺼져 있는지
//    - ↑AN/↓AN: 작가 노트가 들어가는 턴에만 같이 들어가므로 이 채팅의 작가 노트 빈도
// 2) 발동 점검: 키가 없거나, 내용이 비었거나, 확률 0% 거나, 정규식 키가 깨져서 절대 발동하지 않는 엔트리

import { createWorldInfoEntry, loadWorldInfo, openWorldInfoEditor, parseRegexFromString, saveWorldInfo, selected_world_info, world_info, world_info_position, METADATA_KEY } from '../../../world-info.js';
import { promptManager } from '../../../openai.js';
import { metadata_keys as AN_KEYS } from '../../../authors-note.js';
import { copyText } from '../../../utils.js';

const ctx = () => SillyTavern.getContext();

const LOAD_CONCURRENCY = 6;
// 옛 매크로 {{outlet::키}} 와 새 매크로 엔진의 {{outlet 키}} 둘 다
const OUTLET_MACRO = /\{\{\s*outlet(?:::|\s+)(.+?)\s*\}\}/gi;
// ST 가 정규식 키로 보는 모양 (parseRegexFromString 과 같은 틀)
const REGEX_SHAPE = /^\/([\w\W]+?)\/([gimsuy]*)$/;
const DECORATOR_LINE = /^@@\w+.*$/gm;

const POSITION_LABEL = {
    [world_info_position.before]: '↑Char',
    [world_info_position.after]: '↓Char',
    [world_info_position.ANTop]: '↑AN',
    [world_info_position.ANBottom]: '↓AN',
    [world_info_position.atDepth]: '@D',
    [world_info_position.EMTop]: '↑EM',
    [world_info_position.EMBottom]: '↓EM',
    [world_info_position.outlet]: '아웃렛',
};

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 이름 비교용: 앞뒤 공백·대소문자 무시. 정확히는 다르지만 이게 같으면 오타로 본다 */
const looseKey = name => String(name).trim().toLowerCase();

// ---------- 활성 로어북 ----------

/** 지금 채팅에 걸린 로어북 → 걸린 곳 이름들 (전역/캐릭터명/채팅/페르소나) */
function activeBooks() {
    const c = ctx();
    const map = new Map();
    const add = (book, label) => {
        if (!book) return;
        if (!map.has(book)) map.set(book, []);
        if (!map.get(book).includes(label)) map.get(book).push(label);
    };

    for (const book of selected_world_info ?? []) add(book, '전역');

    const members = c.groupId
        ? (c.groups.find(g => g.id == c.groupId)?.members ?? []).map(avatar => c.characters.find(ch => ch.avatar === avatar))
        : [c.characters[c.characterId]];
    for (const character of members.filter(Boolean)) {
        const file = character.avatar?.replace(/\.[^/.]+$/, '');
        add(character.data?.extensions?.world, character.name);
        for (const book of world_info?.charLore?.find(e => e.name === file)?.extraBooks ?? []) add(book, character.name);
    }

    if (c.getCurrentChatId?.()) add(c.chatMetadata?.[METADATA_KEY], '채팅');
    add(c.powerUserSettings?.persona_description_lorebook, '페르소나');
    return map;
}

// ---------- 프리셋·채팅의 출구 ----------

/** 지금 CC 프리셋: {{outlet::}} 이 들어 있는 곳과 WI·예시 대화 마커가 켜져 있는지 */
function presetState() {
    const outlets = new Map();
    const markers = {};
    const pm = promptManager;
    if (!pm?.serviceSettings?.prompts) return { available: false, outlets, markers };

    const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
    const enabled = new Map(order.map(item => [item.identifier, !!item.enabled]));

    for (const id of ['worldInfoBefore', 'worldInfoAfter', 'dialogueExamples']) {
        markers[id] = { on: enabled.get(id) === true, name: pm.getPromptById(id)?.name || id };
    }

    for (const prompt of pm.serviceSettings.prompts) {
        if (!prompt?.content) continue;
        const on = enabled.get(prompt.identifier) === true;
        const label = prompt.name || prompt.identifier;
        for (const match of String(prompt.content).matchAll(OUTLET_MACRO)) {
            const key = match[1].trim();
            if (!outlets.has(key)) outlets.set(key, { on: [], off: [] });
            const slot = outlets.get(key)[on ? 'on' : 'off'];
            if (!slot.includes(label)) slot.push(label);
        }
    }
    return { available: true, outlets, markers };
}

/** 이 채팅의 작가 노트 빈도. 열린 채팅이 없으면 null */
function authorsNoteInterval() {
    const c = ctx();
    if (!c.getCurrentChatId?.()) return null;
    const value = c.chatMetadata?.[AN_KEYS.interval] ?? c.extensionSettings?.note?.defaultInterval;
    return Number(value);
}

function presetName() {
    return ctx().chatCompletionSettings?.preset_settings_openai ?? '';
}

// ---------- 로어북 훑기 ----------

async function loadAllBooks(names, onProgress) {
    const books = new Map();
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < names.length) {
            const name = names[next++];
            try {
                const data = await loadWorldInfo(name);
                if (data?.entries) books.set(name, data);
            } catch (error) {
                console.warn('[Lorebook Check] 로어북을 읽지 못했습니다', name, error);
            }
            onProgress(++done, names.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, names.length) }, worker));
    return books;
}

function entryTitle(entry) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    return entry.comment?.trim() || keys.join(', ') || `#${entry.uid}`;
}

/** 정규식처럼 생겼는데 ST 가 정규식으로 못 읽는 키 (그러면 글자 그대로 찾아서 사실상 안 걸린다) */
function brokenRegexKeys(entry) {
    const keys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])].filter(k => typeof k === 'string');
    return keys.filter(k => REGEX_SHAPE.test(k.trim()) && !parseRegexFromString(k.trim()));
}

/** 절대 발동하지 않는 이유들 */
function neverReasons(entry) {
    const reasons = [];
    const content = String(entry.content ?? '');
    const decorators = content.match(DECORATOR_LINE) ?? [];
    const forced = decorators.some(line => line.startsWith('@@activate'));
    // 벡터 검색으로도 켜질 수 있는 엔트리는 키가 없어도 된다
    const external = forced || !!entry.vectorized;

    if (!content.replace(DECORATOR_LINE, '').trim()) reasons.push({ id: 'empty' });
    if (!entry.constant && !external && !(entry.key ?? []).some(k => String(k).trim())) reasons.push({ id: 'nokey' });
    if (entry.useProbability && Number(entry.probability) === 0 && !forced) reasons.push({ id: 'prob0' });
    const broken = brokenRegexKeys(entry);
    if (broken.length) reasons.push({ id: 'regex', keys: broken });
    if (Number(entry.position) === world_info_position.outlet && !String(entry.outletName ?? '')) reasons.push({ id: 'noname' });
    return reasons;
}

async function scan(onProgress) {
    const names = ctx().getWorldInfoNames();
    const active = activeBooks();
    const books = await loadAllBooks(names, onProgress);

    const entries = [];
    for (const [book, data] of books) {
        for (const entry of Object.values(data.entries)) {
            const position = Number(entry.position);
            entries.push({
                book,
                uid: entry.uid,
                title: entryTitle(entry),
                position,
                // 엔진은 아웃렛 이름을 다듬지 않고 그대로 키로 쓴다
                outlet: position === world_info_position.outlet ? String(entry.outletName ?? '') : null,
                disabled: !!entry.disable,
                activeIn: active.get(book) ?? [],
                never: entry.disable ? [] : neverReasons(entry),
            });
        }
    }
    return {
        entries,
        preset: presetState(),
        anInterval: authorsNoteInterval(),
        stripExamples: !!ctx().powerUserSettings?.strip_examples,
        bookCount: books.size,
        active,
    };
}

// ---------- 분류 ----------

const NEVER_INFO = {
    nokey: { icon: 'fa-key', title: '키 없음', note: '상시(🔵)가 아닌데 키가 비어 있어 발동할 방법이 없습니다.' },
    empty: { icon: 'fa-file', title: '내용 없음', note: '내용이 비어 있어 발동해도 아무것도 들어가지 않습니다.' },
    prob0: { icon: 'fa-dice', title: '확률 0%', note: '확률 사용이 켜져 있고 0%라서 절대 통과하지 못합니다.' },
    regex: { icon: 'fa-code', title: '정규식 오류', note: '/…/ 모양이지만 정규식으로 읽히지 않아 글자 그대로 찾습니다. 사실상 안 걸립니다.' },
    noname: { icon: 'fa-question', title: '아웃렛 이름 없음', note: '위치가 아웃렛인데 이름이 비어 있어 ST가 건너뜁니다.' },
};

const sortEntries = list => list.sort((a, b) => (b.activeIn.length > 0) - (a.activeIn.length > 0) || a.book.localeCompare(b.book) || a.title.localeCompare(b.title));

/** 훑은 결과를 화면에 쓸 카드 묶음으로 나눈다. activeOnly 면 지금 채팅에 걸린 로어북만 */
function classify(result, activeOnly) {
    const { entries, preset, anInterval, stripExamples } = result;
    const pool = activeOnly ? entries.filter(e => e.activeIn.length) : entries;
    const live = pool.filter(e => !e.disabled);
    const problemEntries = new Set();

    const sections = { missing: [], blocked: [], never: [], empty: [], info: [], ok: [] };
    const card = (section, data) => {
        sortEntries(data.entries ?? []);
        if (section !== 'info' && section !== 'ok' && section !== 'empty') data.entries.forEach(e => problemEntries.add(e));
        sections[section].push(data);
    };
    const at = (...positions) => live.filter(e => positions.includes(e.position));

    // 아웃렛
    const byName = new Map();
    for (const entry of live) {
        if (!entry.outlet) continue;
        if (!byName.has(entry.outlet)) byName.set(entry.outlet, []);
        byName.get(entry.outlet).push(entry);
    }
    for (const [name, list] of byName) {
        const slot = preset.outlets.get(name);
        if (slot?.on.length) {
            card('ok', { icon: 'fa-circle-check', code: name, entries: list, prompts: slot });
        } else if (slot?.off.length) {
            card('blocked', { icon: 'fa-toggle-off', code: name, prefix: '아웃렛', note: '매크로가 꺼진(또는 순서에 없는) 프롬프트에만 있습니다.', entries: list, prompts: slot });
        } else {
            const near = [...preset.outlets.keys()].filter(key => key !== name && looseKey(key) === looseKey(name));
            card('missing', { icon: 'fa-triangle-exclamation', code: name, near, entries: list });
        }
    }
    for (const [key, slot] of preset.outlets) {
        if (!slot.on.length || byName.has(key)) continue;
        const disabledOnly = pool.filter(e => e.disabled && e.outlet === key);
        sections.empty.push({ icon: 'fa-plug-circle-xmark', code: key, prompts: slot, entries: sortEntries(disabledOnly), disabledNote: disabledOnly.length > 0 });
    }

    // 마커 프롬프트로 들어가는 위치
    if (preset.available) {
        const marker = (id, positions, label) => {
            const list = at(...positions);
            if (!list.length || preset.markers[id]?.on) return;
            card('blocked', { icon: 'fa-toggle-off', title: `${label} → ${preset.markers[id].name}`, note: `프리셋에서 '${preset.markers[id].name}' 마커가 꺼져 있어 이 위치의 엔트리가 버려집니다.`, entries: list });
        };
        marker('worldInfoBefore', [world_info_position.before], '↑Char');
        marker('worldInfoAfter', [world_info_position.after], '↓Char');
        marker('dialogueExamples', [world_info_position.EMTop, world_info_position.EMBottom], '↑EM/↓EM');
    }
    if (stripExamples) {
        const list = at(world_info_position.EMTop, world_info_position.EMBottom);
        if (list.length) card('blocked', { icon: 'fa-ban', title: '↑EM/↓EM → 예시 대화 안 넣기', note: '고급 서식의 \'예시 대화 안 넣기\'가 켜져 있어 예시 대화 위치 엔트리가 버려집니다.', entries: list });
    }

    // 작가 노트에 붙어 들어가는 위치
    const anList = at(world_info_position.ANTop, world_info_position.ANBottom);
    if (anList.length && anInterval !== null) {
        if (!(anInterval > 0)) {
            card('blocked', { icon: 'fa-pause', title: '↑AN/↓AN → 작가 노트 빈도 0', note: '이 채팅의 작가 노트 빈도가 0이라 작가 노트와 함께 이 위치 엔트리도 들어가지 않습니다.', entries: anList });
        } else if (anInterval > 1) {
            card('info', { icon: 'fa-clock', title: `↑AN/↓AN → ${anInterval}턴마다`, note: `이 채팅의 작가 노트 빈도가 ${anInterval}라서, 발동해도 작가 노트가 들어가는 턴에만 같이 들어갑니다.`, entries: anList });
        }
    }

    // 절대 발동하지 않는 엔트리
    for (const id of Object.keys(NEVER_INFO)) {
        const list = live.filter(e => e.never.some(r => r.id === id));
        if (!list.length) continue;
        const info = NEVER_INFO[id];
        const detail = id === 'regex'
            ? e => e.never.find(r => r.id === 'regex').keys.map(k => `<code>${escapeHtml(k)}</code>`).join(' ')
            : null;
        card('never', { icon: info.icon, title: info.title, note: info.note, entries: list, detail });
    }

    return { sections, problemCount: problemEntries.size, total: pool.length, liveCount: live.length };
}

// ---------- 화면 ----------

function entryRow(entry, detail) {
    const badges = entry.activeIn.length
        ? `<span class="lbchk_badge lbchk_badge_active">${escapeHtml(entry.activeIn.join(' · '))}</span>`
        : '';
    const off = entry.disabled ? '<span class="lbchk_badge">꺼짐</span>' : '';
    const position = POSITION_LABEL[entry.position] ? `<span class="lbchk_badge">${POSITION_LABEL[entry.position]}</span>` : '';
    const extra = detail ? `<div class="lbchk_entry_detail">${detail(entry)}</div>` : '';
    return `
        <li class="lbchk_entry">
            <div class="lbchk_entry_text">
                <div class="lbchk_entry_title">${escapeHtml(entry.title)}</div>
                <div class="lbchk_entry_meta">
                    <i class="fa-solid fa-book"></i>
                    <span class="lbchk_book">${escapeHtml(entry.book)}</span>
                    ${position}${badges}${off}
                </div>
                ${extra}
            </div>
            <button type="button" class="menu_button lbchk_open" data-book="${escapeHtml(entry.book)}" data-uid="${escapeHtml(entry.uid)}" data-title="${escapeHtml(entry.title)}" title="로어북 편집기에서 열기" aria-label="로어북 편집기에서 열기"><i class="fa-solid fa-pen"></i></button>
        </li>`;
}

function promptNote(prompts) {
    if (!prompts) return '';
    const parts = [];
    if (prompts.on.length) parts.push(`켜진 프롬프트: ${prompts.on.map(escapeHtml).join(', ')}`);
    if (prompts.off.length) parts.push(`꺼진 프롬프트: ${prompts.off.map(escapeHtml).join(', ')}`);
    return parts.length ? `<div class="lbchk_note">${parts.join('<br>')}</div>` : '';
}

function renderCard(data, section) {
    const label = data.code !== undefined
        ? `${data.prefix ? `<span class="lbchk_prefix">${data.prefix}</span>` : ''}<code class="lbchk_name">${escapeHtml(data.code)}</code>`
        : `<span class="lbchk_name">${escapeHtml(data.title)}</span>`;
    const near = data.near?.length
        ? `<div class="lbchk_note lbchk_warn">이름이 비슷한 매크로가 있어요: ${data.near.map(k => `<code>${escapeHtml(k)}</code>`).join(', ')} (대소문자·공백까지 같아야 합니다)</div>`
        : '';
    const note = data.note ? `<div class="lbchk_note">${escapeHtml(data.note)}</div>` : '';
    const disabledNote = data.disabledNote ? '<div class="lbchk_note lbchk_warn">꺼진 엔트리만 있어요:</div>' : '';
    const list = data.entries?.length ? `<ul class="lbchk_entries">${data.entries.map(e => entryRow(e, data.detail)).join('')}</ul>` : '';
    const open = section === 'ok' || section === 'info' ? '' : 'open';
    // 로어북에만 있는 아웃렛 → 프리셋에 붙여 넣을 매크로 복사 / 프리셋에만 있는 아웃렛 → 그 이름의 엔트리 만들기
    const action = section === 'missing'
        ? `<button type="button" class="lbchk_pill" data-copy="${escapeHtml(outletMacro(data.code))}" title="눌러서 복사"><i class="fa-regular fa-copy"></i><code>${escapeHtml(outletMacro(data.code))}</code></button>`
        : section === 'empty'
            ? `<button type="button" class="menu_button lbchk_create" data-outlet="${escapeHtml(data.code)}"><i class="fa-solid fa-plus"></i><span>이 이름으로 엔트리 만들기</span></button>`
            : '';
    return `
        <details class="lbchk_card" data-status="${section}" ${open}>
            <summary class="lbchk_card_head">
                <i class="fa-solid ${data.icon} lbchk_status_icon"></i>
                ${label}
                ${data.entries?.length ? `<span class="lbchk_count">${data.entries.length}</span>` : ''}
                <i class="fa-solid fa-chevron-down lbchk_chevron"></i>
            </summary>
            ${near}${note}${promptNote(data.prompts)}${action}${disabledNote}${list}
        </details>`;
}

const outletMacro = name => `{{outlet::${name}}}`;

/**
 * 클립보드 복사. 클립보드 API 가 거절하면(창에 초점이 없을 때 등) 숨긴 입력칸으로 한 번 더 시도한다.
 * 입력칸은 열린 팝업(dialog) 안에 넣어야 모달 바깥이라 선택이 막히는 일이 없다.
 */
async function copyMacro(text, near) {
    try {
        await copyText(text);
        return true;
    } catch {
        const parent = near.closest('dialog') ?? document.body;
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;opacity:0;left:0;top:0;';
        parent.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    }
}

const SECTIONS = [
    ['missing', '로어북에만 있는 아웃렛', 'fa-triangle-exclamation', '프리셋에 넣어야 들어가요. 아래 매크로를 눌러 복사한 뒤 프리셋 프롬프트에 붙여 넣으세요.'],
    ['blocked', '출구 꺼짐', 'fa-toggle-off', '엔트리 위치에 맞는 출구가 지금 프리셋·채팅에서 닫혀 있습니다.'],
    ['never', '발동 안 됨', 'fa-ban', '설정 때문에 절대 프롬프트에 들어가지 않는 엔트리입니다.'],
    ['empty', '프리셋에만 있는 아웃렛', 'fa-plug-circle-xmark', '로어북에 이 이름의 켜진 엔트리가 없어서 빈칸으로 들어가요.'],
    ['info', '참고', 'fa-circle-info', ''],
    ['ok', '연결된 아웃렛', 'fa-circle-check', ''],
];

function renderResult(result, activeOnly) {
    const { sections, problemCount, total, liveCount } = classify(result, activeOnly);

    if (!total) {
        return `<div class="lbchk_empty">${activeOnly ? '지금 채팅에 걸린 로어북에' : '어느 로어북에도'} 엔트리가 없습니다.</div>`;
    }

    const summary = problemCount
        ? `<div class="lbchk_summary" data-state="bad"><i class="fa-solid fa-triangle-exclamation"></i><span>켜진 엔트리 ${liveCount}개 중 ${problemCount}개가 프롬프트에 들어가지 않습니다</span></div>`
        : `<div class="lbchk_summary" data-state="good"><i class="fa-solid fa-circle-check"></i><span>켜진 엔트리 ${liveCount}개에서 문제를 찾지 못했습니다</span></div>`;

    const body = SECTIONS.map(([key, title, icon, help]) => {
        const cards = sections[key];
        if (!cards.length) return '';
        return `
            <section class="lbchk_section" data-status="${key}">
                <h4 class="lbchk_section_title"><i class="fa-solid ${icon}"></i><span>${title}</span><span class="lbchk_count">${cards.length}</span></h4>
                ${help ? `<div class="lbchk_help">${escapeHtml(help)}</div>` : ''}
                ${cards.map(card => renderCard(card, key)).join('')}
            </section>`;
    }).join('');

    const warn = result.preset.available ? '' : '<div class="lbchk_note lbchk_warn">프롬프트 관리자를 읽지 못해 프리셋 점검을 건너뛰었습니다.</div>';
    return summary + warn + body;
}

// ---------- 편집기로 이동 ----------

async function waitFor(check, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

async function openEntry(book, uid, title) {
    openWorldInfoEditor(book);
    // 로어북을 바꾸면 ST가 검색칸을 비우므로, 다 그려진 뒤에 엔트리 제목으로 검색해 페이지 밖에 있어도 보이게 한다
    const selected = () => $('#world_editor_select option:selected').text() === book && $('#world_popup_entries_list .world_entry').length > 0;
    if (!await waitFor(selected)) return;
    $('#world_info_search').val(title).trigger('input');
    const element = await waitFor(() => document.querySelector(`#world_popup_entries_list .world_entry[uid="${CSS.escape(String(uid))}"]`));
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.add('lbchk_flash');
    setTimeout(() => element.classList.remove('lbchk_flash'), 2000);
}

// ---------- 엔트리 만들기 ----------

/** 새 엔트리를 넣을 로어북 고르기. 지금 채팅에 걸린 로어북을 위에 두고 채팅 로어북을 먼저 고른다 */
async function pickBook(active) {
    const { Popup, POPUP_TYPE, POPUP_RESULT, getWorldInfoNames, chatMetadata } = ctx();
    const names = getWorldInfoNames();
    if (!names.length) {
        toastr.warning('로어북이 없습니다. 먼저 로어북을 만들어 주세요.');
        return null;
    }
    const others = names.filter(name => !active.has(name));
    const option = (name, label) => `<option value="${escapeHtml(name)}">${escapeHtml(label ? `${name} (${label})` : name)}</option>`;
    const root = document.createElement('div');
    root.className = 'lbchk lbchk_pick';
    root.innerHTML = `
        <h3 class="lbchk_title"><i class="fa-solid fa-plus"></i><span>어느 로어북에 만들까요?</span></h3>
        <select class="text_pole lbchk_select">
            ${active.size ? `<optgroup label="지금 채팅에 걸린 로어북">${[...active].map(([name, labels]) => option(name, labels.join(' · '))).join('')}</optgroup>` : ''}
            ${others.length ? `<optgroup label="다른 로어북">${others.map(name => option(name)).join('')}</optgroup>` : ''}
        </select>`;
    const select = root.querySelector('select');
    const preferred = chatMetadata?.[METADATA_KEY];
    if (preferred && names.includes(preferred)) select.value = preferred;

    const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', { okButton: '만들기', cancelButton: '취소', leftAlign: true });
    const answer = await popup.show();
    return answer === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
}

/** 위치가 아웃렛이고 이름이 정해진 상시(🔵) 엔트리를 만들어 바로 저장한다 */
async function createOutletEntry(book, name) {
    const data = await loadWorldInfo(book);
    const entry = data && createWorldInfoEntry(book, data);
    if (!entry) throw new Error(`엔트리를 만들지 못했습니다: ${book}`);
    Object.assign(entry, { comment: name, position: world_info_position.outlet, outletName: name, constant: true });
    await saveWorldInfo(book, data, true);
    return entry;
}

// ---------- 팝업 ----------

async function openCheckPopup() {
    const { Popup, POPUP_TYPE, mainApi } = ctx();
    const root = document.createElement('div');
    root.className = 'lbchk';
    const preset = presetName();
    root.innerHTML = `
        <h3 class="lbchk_title"><i class="fa-solid fa-stethoscope"></i><span>로어북 점검</span></h3>
        <div class="lbchk_preset">
            <span class="lbchk_preset_label">프리셋</span>
            <span class="lbchk_preset_name">${escapeHtml(preset || '(이름 없음)')}</span>
        </div>
        ${mainApi === 'openai' ? '' : '<div class="lbchk_note lbchk_warn">지금 API가 Chat Completion이 아니라서 프리셋 점검 결과는 실제와 다를 수 있습니다.</div>'}
        <label class="checkbox_label lbchk_toggle">
            <input type="checkbox" class="lbchk_active_only" ${ctx().getCurrentChatId?.() ? 'checked' : ''}>
            <span>지금 채팅에 걸린 로어북만</span>
        </label>
        <div class="lbchk_status">로어북을 읽는 중…</div>
        <div class="lbchk_body"></div>`;

    const find = selector => root.querySelector(selector);
    const popup = new Popup(root, POPUP_TYPE.TEXT, '', { okButton: '닫기', wide: true, leftAlign: true, allowVerticalScrolling: true });
    const shown = popup.show();

    let result = null;
    const draw = () => {
        if (!result) return;
        find('.lbchk_body').innerHTML = renderResult(result, find('.lbchk_active_only').checked);
    };

    find('.lbchk_active_only').addEventListener('change', draw);
    find('.lbchk_body').addEventListener('click', async event => {
        const pill = event.target.closest('.lbchk_pill');
        if (pill) {
            if (await copyMacro(pill.dataset.copy, pill)) {
                toastr.success(`${pill.dataset.copy} 복사했어요. 프리셋 프롬프트에 붙여 넣으세요.`);
            } else {
                toastr.error('복사하지 못했습니다. 길게 눌러 직접 복사해 주세요.');
            }
            return;
        }

        const create = event.target.closest('.lbchk_create');
        if (create) {
            const name = create.dataset.outlet;
            const book = await pickBook(result.active);
            if (!book) return;
            try {
                const entry = await createOutletEntry(book, name);
                toastr.success(`'${book}'에 아웃렛 '${name}' 상시 엔트리를 만들었어요. 내용을 채워 주세요.`);
                await popup.completeCancelled();
                await openEntry(book, entry.uid, name);
            } catch (error) {
                console.error('[Lorebook Check] 엔트리 만들기 실패', error);
                toastr.error('엔트리를 만들지 못했습니다. 콘솔을 확인해 주세요.');
            }
            return;
        }

        const button = event.target.closest('.lbchk_open');
        if (!button) return;
        const { book, uid, title } = button.dataset;
        await popup.completeCancelled();
        await openEntry(book, uid, title);
    });

    try {
        result = await scan((done, total) => {
            find('.lbchk_status').textContent = `로어북을 읽는 중… ${done} / ${total}`;
        });
        find('.lbchk_status').textContent = `로어북 ${result.bookCount}개 · 지금 걸린 로어북 ${result.active.size}개 · 엔트리 ${result.entries.length}개`;
        draw();
    } catch (error) {
        console.error('[Lorebook Check] 점검 실패', error);
        find('.lbchk_status').textContent = '점검 중 오류가 났습니다. 콘솔을 확인해 주세요.';
    }

    await shown;
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const container = document.createElement('div');
    container.id = 'lbchk_wand_container';
    container.className = 'extension_container';
    container.innerHTML = `
        <div id="lbchk_wand_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-stethoscope extensionsMenuExtensionButton"></div>
            로어북 점검
        </div>
    `;
    menu.append(container);
    container.querySelector('#lbchk_wand_button').addEventListener('click', openCheckPopup);
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lorebookcheck',
        callback: async () => {
            await openCheckPopup();
            return '';
        },
        helpString: '모든 로어북에서 켜져 있는데 프롬프트에 들어가지 않는 엔트리(프리셋에 빠진 아웃렛, 꺼진 마커, 발동 불가 설정)를 찾습니다.',
    }));
}

jQuery(() => {
    addWandButton();
    registerSlashCommand();
});
