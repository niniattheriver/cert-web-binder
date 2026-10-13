-- 009_system_name (설계서 §4): 시스템 표시명 기본값을 '우수검사실 신임인증 웹 바인더'로 바꾼다
-- ① 옛 기본값('우수검사실 인증심사 웹 바인더')을 그대로 쓰던 설치만 바꾼다. 기관 정보 화면에서 직접 정한 이름은 그대로 둔다.
-- ② 바꿀 때는 기관 정보 화면의 수정과 같은 모양(entity 'app_setting', 전후 orgName, systemName)으로 change_log에 남긴다.
-- ③ 새 DB는 이 시점에 app_setting이 비어 있어 아무것도 하지 않는다. 새 기본값은 기동 시드(bootstrap.ts)가 넣는다.
INSERT INTO change_log (ts, actor_kind, entity, entity_id, action, before_json, after_json)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'app_setting', 0, 'update',
       json_object('orgName', COALESCE((SELECT value FROM app_setting WHERE key = 'orgName'), ''),
                   'systemName', '우수검사실 인증심사 웹 바인더'),
       json_object('orgName', COALESCE((SELECT value FROM app_setting WHERE key = 'orgName'), ''),
                   'systemName', '우수검사실 신임인증 웹 바인더')
WHERE EXISTS (SELECT 1 FROM app_setting WHERE key = 'systemName' AND value = '우수검사실 인증심사 웹 바인더');
UPDATE app_setting SET value = '우수검사실 신임인증 웹 바인더'
WHERE key = 'systemName' AND value = '우수검사실 인증심사 웹 바인더';
