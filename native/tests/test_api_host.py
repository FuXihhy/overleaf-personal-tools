"""Native API routing and cancellation; no network, Codex login or inference."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from test_codex_host import host, request, Messages, PROJECT


OTHER_PROVIDER = '99999999-2222-3333-4444-555555555555'
SECRET = 'synthetic-api-key-do-not-return'


class APIHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.messages = Messages()
        self.message_patch = mock.patch.object(host, 'write_message', self.messages.add)
        self.message_patch.start()
        self.start_worker = threading.Event()
        real_worker = host.NativeHost._worker

        def gated_worker(native):
            self.start_worker.wait(3)
            real_worker(native)

        self.worker_patch = mock.patch.object(host.NativeHost, '_worker', gated_worker)
        self.worker_patch.start()
        self.server_factory = mock.Mock(side_effect=AssertionError('API requests must not launch Codex'))
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(Path(self.temp.name) / 'state'),
                                      self.server_factory)
        self.profile = self.native.profiles.save({
            'name': 'Synthetic API', 'baseUrl': 'https://api.example.invalid/v1',
            'model': 'test-model', 'apiKey': SECRET,
        })
        self.connections = []
        self.connection_factory = mock.Mock(side_effect=self.connection)
        self.native.api_backend.connection_factory = self.connection_factory

    def connection(self, profile, cancelled):
        value = mock.Mock()
        value.models.return_value = [{'id': 'discovered-model', 'displayName': 'discovered-model', 'efforts': []}]
        value.profile = profile
        value.cancelled = cancelled
        value.stream.side_effect = lambda messages, on_delta: on_delta('Synthetic API answer.')
        self.connections.append(value)
        return value

    def tearDown(self):
        self.start_worker.set()
        self.native.close()
        self.worker_patch.stop()
        self.message_patch.stop()
        self.temp.cleanup()

    def send(self, value, kind):
        self.start_worker.set()
        self.native.handle(value)
        return self.messages.wait(kind, value['id'])

    def management(self, op, identifier, **fields):
        return {'version': 1, 'id': identifier, 'op': op, **fields}

    def test_profile_list_is_local_and_status_discovers_models_without_codex_or_inference(self):
        result = self.send(self.management('provider-list', 'list'), 'profiles')
        self.assertEqual(result['profiles'], [self.profile])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn('apiKey', result['profiles'][0])
        self.connection_factory.assert_not_called()
        status = self.send({'version': 1, 'id': 'status', 'op': 'status',
                            'projectId': PROJECT, 'providerId': self.profile['id']}, 'status')
        self.assertTrue(status['available'])
        self.assertEqual(status['models'][0]['id'], 'discovered-model')
        self.server_factory.assert_not_called()
        self.connection_factory.assert_called_once()
        self.connections[0].stream.assert_not_called()
        self.connections[0].close.assert_called_once()

    def test_save_test_and_delete_use_profile_path_without_exposing_key(self):
        saved = self.send(self.management('provider-save', 'save', profile={
            'id': self.profile['id'], 'name': 'Renamed', 'baseUrl': self.profile['baseUrl'],
            'model': 'test-model', 'apiKey': '',
        }), 'profiles')
        self.assertEqual(saved['profiles'][0]['name'], 'Renamed')
        self.assertTrue(saved['profiles'][0]['hasKey'])
        self.assertEqual(self.native.profiles.get(self.profile['id'])['apiKey'], SECRET)
        with mock.patch.object(self.native.profiles, 'test', return_value=[]) as probe:
            checked = self.send(self.management('provider-test', 'test', providerId=self.profile['id']), 'profiles')
            probe.assert_called_once_with(self.profile['id'])
        deleted = self.send(self.management('provider-delete', 'delete', providerId=self.profile['id']), 'profiles')
        self.assertEqual(deleted['profiles'], [])
        for result in (saved, checked, deleted):
            self.assertNotIn(SECRET, json.dumps(result))
        self.server_factory.assert_not_called()
        self.connection_factory.assert_not_called()

    def test_unknown_provider_fails_without_falling_back_to_codex(self):
        result = self.send(request(providerId=OTHER_PROVIDER), 'error')
        self.assertIn('no longer exists', result['message'])
        self.server_factory.assert_not_called()
        self.connection_factory.assert_not_called()

    def test_credentials_are_rejected_on_normal_question_envelope(self):
        result = self.send(request(profile={'apiKey': SECRET}, providerId=self.profile['id']), 'error')
        self.assertIn('extension connection settings', result['message'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.server_factory.assert_not_called()
        self.connection_factory.assert_not_called()

    def test_api_ask_persists_context_and_history_without_codex(self):
        first = self.send(request(providerId=self.profile['id']), 'done')
        second = self.send(request(id='ask-2', providerId=self.profile['id'], question='Explain again.',
                                   selection=None, files=[]), 'done')
        self.assertEqual(first['threadId'], second['threadId'])
        self.assertEqual(len(self.connections), 2)
        sent = self.connections[1].stream.call_args.args[0]
        self.assertIn('Some definitions.', json.dumps(sent))
        self.assertIn('Synthetic API answer.', json.dumps(sent))
        page = self.send({'version': 1, 'id': 'read', 'op': 'history-read',
                          'projectId': PROJECT, 'accountId': 'account-one',
                          'providerId': self.profile['id']}, 'history')
        self.assertEqual(len(page['messages']), 4)
        self.assertEqual(page['messages'][0]['selection']['text'], 'x+y')
        self.assertEqual(self.native.store.list(request())['conversations'], [])
        self.server_factory.assert_not_called()

    def test_selected_api_model_reaches_transport_without_overwriting_connection_default(self):
        value=request(providerId=self.profile['id'])
        value['settings'].update(providerId=self.profile['id'], apiModel='vendor/model@v2+fast', model='gpt-6-astra')
        self.send(value,'done')
        self.assertEqual(self.connections[0].profile['model'],'vendor/model@v2+fast')
        self.assertEqual(self.native.profiles.get(self.profile['id'])['model'],'test-model')
        value['id']='invalid-model';value['settings']['apiModel']='bad id'
        self.assertIn('Invalid API model',self.send(value,'error')['message'])
        self.assertEqual(len(self.connections),1)

    def test_native_validation_preserves_only_bounded_api_reading_limits(self):
        limits = {'apiMaxReadRounds': (1, 64, 256), 'apiMaxToolCalls': (1, 128, 512),
                  'apiTimeoutSeconds': (90, 580, 580)}
        for key, (minimum, default, maximum) in limits.items():
            for number in (minimum, default, maximum):
                value = request(providerId=self.profile['id'])
                value['settings'][key] = number
                self.assertEqual(host.validate_request(value)['settings'][key], number)
            for invalid in (True, False, None, str(default), minimum + 0.5, minimum - 1, maximum + 1):
                with self.subTest(key=key, invalid=invalid):
                    value = request(providerId=self.profile['id'])
                    value['settings'][key] = invalid
                    with self.assertRaisesRegex(host.HostError, 'Invalid API reading budget'):
                        host.validate_request(value)
            value = request()
            value['settings'][key] = default
            with self.assertRaisesRegex(host.HostError, 'API connection'):
                host.validate_request(value)
        legacy = host.validate_request(request(providerId=self.profile['id']))['settings']
        self.assertTrue(all(key not in legacy for key in limits))
        self.connection_factory.assert_not_called()

    def test_immediate_cancel_before_worker_admission_prevents_network(self):
        self.native.handle(request(providerId=self.profile['id']))
        self.native.handle({'version': 1, 'id': 'stop', 'op': 'cancel',
                            'projectId': PROJECT, 'providerId': self.profile['id']})
        stopped = self.messages.wait('done', 'stop')
        self.assertTrue(stopped['cancelled'])
        self.start_worker.set()
        result = self.messages.wait('done')
        self.assertTrue(result['cancelled'])
        self.server_factory.assert_not_called()
        self.connection_factory.assert_not_called()

    def test_wrong_provider_cannot_cancel_a_queued_question(self):
        self.native.handle(request(providerId=self.profile['id']))
        self.native.handle({'version': 1, 'id': 'wrong-stop', 'op': 'cancel',
                            'projectId': PROJECT, 'providerId': OTHER_PROVIDER})
        result = self.messages.wait('error', 'wrong-stop')
        self.assertIn('different model source', result['message'])
        self.assertFalse(self.native.cancelled.is_set())
        self.start_worker.set()
        completed = self.messages.wait('done')
        self.assertFalse(completed['cancelled'])
        self.assertEqual(len(self.connections), 1)
        self.server_factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
