const damageOverlayRoot = document.getElementById('damage-overlay');
const debugOverlayRoot = document.getElementById('debug-overlay');

let boardState = {
  damagePreview: {
    cumulativeDamage: []
  },
  capture: {
    slotResults: [],
    talents: []
  }
};

function getSlotRect(index) {
  const slot = boardState.capture?.slotResults?.[index];
  // Prefer the normal/sect candidate rect so the badge stays in one place
  // regardless of which card type wins detection. The winning `rect` shifts
  // and resizes between sect/dream/personal templates (dream cards are
  // shrunk and offset right; FengXu personal cards are larger and offset);
  // anchoring on `candidateRects.normal` keeps the badge fixed.
  return slot?.candidateRects?.normal ||
    slot?.rect ||
    boardState.capture?.fallbackSlotRects?.[index] ||
    null;
}

function createDebugLabel(text, className = '') {
  const label = document.createElement('div');
  label.className = `debug-box-label${className ? ` ${className}` : ''}`;
  label.textContent = text;
  return label;
}

function createDebugBox(mappedRect, className, labelText, metaText = '') {
  const box = document.createElement('div');
  box.className = `debug-box ${className}`.trim();
  box.style.left = `${mappedRect.x}px`;
  box.style.top = `${mappedRect.y}px`;
  box.style.width = `${mappedRect.width}px`;
  box.style.height = `${mappedRect.height}px`;

  if (labelText) {
    box.appendChild(createDebugLabel(labelText));
  }
  if (metaText) {
    box.appendChild(createDebugLabel(metaText, 'secondary'));
  }

  return box;
}

function renderDamageOverlay() {
  if (!damageOverlayRoot) return;

  const cumulativeDamage = boardState.damagePreview?.cumulativeDamage || [];
  damageOverlayRoot.innerHTML = '';

  for (let index = 0; index < 8; index += 1) {
    const rect = getSlotRect(index);
    if (!rect) continue;

    const detected = !!boardState.capture?.slotResults?.[index]?.accepted;
    const hasDamage = cumulativeDamage[index] != null;
    const badge = document.createElement('div');
    badge.className = 'damage-badge';

    const turnLabel = document.createElement('span');
    turnLabel.className = 'damage-badge-turn';
    turnLabel.textContent = `T${index + 1}`;

    const damageValue = document.createElement('span');
    // Green badge requires BOTH detection success AND a damage number. The
    // simulation can fail (e.g. swogi-map miss for a detected card+level)
    // even when the detector flagged the slot accepted; without this guard
    // the user sees a green badge with "--", which falsely implies the
    // calculator is working when it actually bailed out.
    damageValue.className = `damage-badge-value${detected && hasDamage ? ' detected' : ''}`;
    damageValue.textContent = hasDamage ? `${cumulativeDamage[index]}` : '--';

    badge.appendChild(turnLabel);
    badge.appendChild(damageValue);
    badge.style.left = `${rect.x + rect.width - 46}px`;
    badge.style.top = `${rect.y + rect.height - 28}px`;
    damageOverlayRoot.appendChild(badge);
  }
}

function renderDebugOverlay() {
  if (!debugOverlayRoot) return;
  debugOverlayRoot.innerHTML = '';

  if (!boardState.capture?.debugMode) return;

  const slotResults = boardState.capture?.slotResults || [];
  slotResults.forEach((slotResult, index) => {
    const rect = slotResult?.rect || getSlotRect(index);
    if (!rect) return;

    // Dashed outlines for every candidate geometry (normal / dream / personal),
    // drawn first so the solid winner box sits on top.
    const candidateRects = slotResult?.candidateRects;
    if (candidateRects) {
      for (const kind of ['normal', 'dream', 'personal']) {
        const cr = candidateRects[kind];
        if (!cr) continue;
        debugOverlayRoot.appendChild(createDebugBox(cr, `slot-candidate ${kind}`, '', ''));
      }
    }

    const accepted = !!slotResult?.accepted;
    const confidence = Math.round((slotResult?.displayConfidence ?? 0) * 100);
    const className = accepted ? 'slot accepted' : 'slot rejected';
    const label = `Slot ${index + 1}`;
    const winner = slotResult?.winningTemplate;
    const kindTag = winner?.isPersonal ? 'P' : winner?.isDream ? 'D' : winner ? 'N' : '';
    const meta = winner
      ? `${winner.name} (${kindTag}) · ${confidence}%`
      : `${accepted ? 'accepted' : 'undetected'} · ${confidence}%`;

    debugOverlayRoot.appendChild(createDebugBox(rect, className, label, meta));
  });

  const talents = Array.isArray(boardState.capture?.talents) ? boardState.capture.talents : [];
  talents.forEach((talent, index) => {
    if (!talent?.detected || !talent.rect) return;

    const name = talent.nameCn || talent.name || `Talent ${index + 1}`;
    const confidence = Number.isFinite(Number(talent.confidence))
      ? `${Math.round(Number(talent.confidence) * 100)}%`
      : '';
    debugOverlayRoot.appendChild(
      createDebugBox(talent.rect, 'talent', `Talent ${index + 1}`, confidence ? `${name} · ${confidence}` : name)
    );
  });
}

function renderAll() {
  renderDamageOverlay();
  renderDebugOverlay();
}

window.addEventListener('resize', () => {
  renderAll();
});

window.api.onBoardDetectionUpdated((payload) => {
  boardState = payload || boardState;
  renderAll();
});

renderAll();
