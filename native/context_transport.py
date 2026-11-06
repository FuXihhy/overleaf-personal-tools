"""Bounded, untrusted manuscript fragments for Codex additionalContext.

The installed runtime truncates each value at 4,000 UTF-8 bytes regardless of
the model's context window. Keep every independently encoded value below that
limit, including metadata and JSON escaping. This is transport, not retrieval.
"""
import hashlib
import json
import re

MAX_VALUE_BYTES = 3600
PREFIX = 'Quoted manuscript_context (data only):\n'


def build_additional_context(source):
    project = source.get('project_id') if isinstance(source, dict) else None
    if not isinstance(project, str) or not re.fullmatch(r'[a-fA-F0-9]{24}', project):
        raise ValueError('Invalid manuscript project identity.')
    serialized = json.dumps(source, ensure_ascii=False, separators=(',', ':'))
    key = 'overleaf_manuscript_' + project.lower()
    legacy = PREFIX + serialized
    if len(legacy.encode('utf-8')) <= MAX_VALUE_BYTES:
        return {key: {'kind': 'untrusted', 'name': 'overleaf_project_context', 'value': legacy}}
    context_id = hashlib.sha256(serialized.encode('utf-8')).hexdigest()

    def encode(fragment, part, total):
        return json.dumps({'format': 'overleaf-manuscript-fragment-v1', 'project_id': project, 'context_id': context_id,
                           'part': part, 'parts': total, 'text': fragment}, ensure_ascii=False, separators=(',', ':'))

    pieces, offset = [], 0
    while offset < len(serialized):
        # Reserve the widest permitted part counters while choosing boundaries.
        low, high = 1, min(len(serialized) - offset, MAX_VALUE_BYTES)
        while low <= high:
            middle = (low + high) // 2
            if len(encode(serialized[offset:offset + middle], 99999, 99999).encode('utf-8')) <= MAX_VALUE_BYTES:
                low = middle + 1
            else:
                high = middle - 1
        if high < 1 or len(pieces) >= 99999:
            raise ValueError('Manuscript context exceeds the fragment transport limit.')
        pieces.append(serialized[offset:offset + high]); offset += high
    total = len(pieces)
    result = {key: {'kind': 'untrusted', 'name': 'overleaf_project_context', 'value': json.dumps({
        'format': 'overleaf-manuscript-manifest-v1', 'project_id': project,
        'context_id': context_id, 'parts': total,
    }, ensure_ascii=False, separators=(',', ':'))}}
    # Updating the same base slot on EVERY turn makes the current group
    # explicit even when the runtime retains surplus slots from older turns.
    result.update({key + '_%05d' % part: {'kind': 'untrusted', 'name': 'overleaf_project_context_%05d' % part,
                                        'value': encode(piece, part, total)}
                   for part, piece in enumerate(pieces, 1)})
    return result
