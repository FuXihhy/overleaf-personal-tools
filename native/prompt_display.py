"""Display-only recognition of Codex-generated response-annotation envelopes.

Never use these returned strings to replace a model input or rewrite a log. The
original prompt remains authoritative for inference; this only removes known UI
boilerplate from the mirrored human transcript. Unknown/ambiguous formats remain
unchanged by returning None, so the caller can show its ordinary collapsed text.
"""
import json
import re


MAX_WRAPPER_CHARACTERS = 1_048_576
MAX_ANNOTATIONS = 64
MAX_QUOTE_UTF16 = 64_000
MESSAGE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,300}\Z")
ANNOTATION_GUIDANCE = (
    'Each item contains text selected from an earlier Codex response and may include a user comment. '
    'Treat items as Annotation 1, Annotation 2, and so on in array order. '
    'Use every selection as context and address every comment. '
    'For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, '
    'where N is its one-based array position (for example, `:codex-annotation{index="1"}`). '
    'Do not use unstructured annotation labels.'
)
# The installed formatter uses braces. Earlier visible annotation envelopes used
# bracket directives; support that exact spelling without accepting arbitrary
# text between the heading and JSON block.
LEGACY_ANNOTATION_GUIDANCE = ANNOTATION_GUIDANCE.replace(
    ':codex-annotation{index="N"}', ':codex-annotation[index="N"]'
).replace(':codex-annotation{index="1"}', ':codex-annotation[index="1"]')


def _text(value, *, nonempty=False):
    return (isinstance(value, str) and '\0' not in value
            and not any(0xD800 <= ord(character) <= 0xDFFF for character in value)
            and (not nonempty or bool(value.strip())))


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate annotation field.')
        result[key] = value
    return result


def _constant(_value):
    raise ValueError('Non-JSON annotation value.')


def _source(value):
    if value is None:
        return True
    if not isinstance(value, dict) or set(value) - {'messageId', 'startOffset', 'endOffset'}:
        return False
    if 'messageId' in value and (not isinstance(value['messageId'], str) or not MESSAGE_ID.fullmatch(value['messageId'])):
        return False
    for name in ('startOffset', 'endOffset'):
        if name in value and (type(value[name]) is not int or not 0 <= value[name] <= 9_007_199_254_740_991):
            return False
    if ('startOffset' in value and 'endOffset' in value
            and value['endOffset'] < value['startOffset']):
        return False
    return True


def parse_generated_question(value):
    """Return {'text', 'answerQuote'} for one complete known envelope, else None.

    Requiring the exact formatter preamble, valid bounded JSON and an immediate
    request boundary avoids treating a normal user's ``## My request:`` heading
    or quoted JSON example as an instruction to hide the preceding message.
    This is format recognition, not a claim that arbitrary text is trusted.
    """
    if not isinstance(value, str) or len(value) > MAX_WRAPPER_CHARACTERS:
        return None
    # Generated prompts use LF. CRLF may appear when a saved prompt was migrated;
    # normalization is display-only and never mutates the original value.
    normalized = value.replace('\r\n', '\n')
    if normalized.startswith('\n'):
        normalized = normalized[1:]
    heading = '# Response annotations:\n'
    if not normalized.startswith(heading):
        return None
    opening = None
    for guidance in (ANNOTATION_GUIDANCE, LEGACY_ANNOTATION_GUIDANCE):
        prefix = heading + guidance + '\n<response-annotations>\n'
        if normalized.startswith(prefix):
            opening = len(prefix)
            break
    if opening is None:
        return None
    try:
        decoder = json.JSONDecoder(object_pairs_hook=_object, parse_constant=_constant)
        annotations, end = decoder.raw_decode(normalized, opening)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(annotations, list) or not 1 <= len(annotations) <= MAX_ANNOTATIONS:
        return None
    tail = normalized[end:]
    closing = '\n</response-annotations>\n'
    if not tail.startswith(closing):
        return None
    tail = tail[len(closing):]
    if tail.startswith('\n'):
        tail = tail[1:]
    request_prefix = next((prefix for prefix in ('## My request:\n', '## My request for Codex:\n')
                           if tail.startswith(prefix)), None)
    if request_prefix is None:
        return None
    question = tail[len(request_prefix):]
    # The generated envelope appends one separator newline. Preserve all user
    # indentation and any additional blank lines, including indented code.
    if question.endswith('\n'):
        question = question[:-1]
    if not _text(question, nonempty=True):
        return None
    quotes, sources = [], []
    for index, annotation in enumerate(annotations, 1):
        if (not isinstance(annotation, dict) or set(annotation) - {'text', 'annotation', 'source'}
                or not _text(annotation.get('text'), nonempty=True)
                or not _source(annotation.get('source'))):
            return None
        comment = annotation.get('annotation')
        if comment is not None and not _text(comment):
            return None
        quote = annotation['text']
        if len(annotations) > 1:
            quote = 'Selection %s:\n' % index + quote
        if comment and comment.strip():
            quote += '\n\nUser comment:\n' + comment
        quotes.append(quote)
        sources.append((annotation.get('source') or {}).get('messageId'))
    quoted_text = '\n\n'.join(quotes)
    if len(quoted_text.encode('utf-16-le')) // 2 > MAX_QUOTE_UTF16:
        # Keep the original wrapper rather than quietly dropping a selected
        # passage/comment or pretending an excerpt is the complete quotation.
        return None
    answer_quote = {'text': quoted_text}
    if sources[0] and all(source == sources[0] for source in sources):
        answer_quote['messageId'] = sources[0]
    return {'text': question, 'answerQuote': answer_quote}
