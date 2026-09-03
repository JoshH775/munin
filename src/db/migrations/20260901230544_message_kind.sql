-- 'chat' = a real message; 'tool'/'thinking' = a status line, kept out of the model transcript
alter table messages add column kind text not null default 'chat';

update messages set kind = 'thinking'
  where user_id = '1538641284711849984' and content = '-# *Thinking...*';

update messages set kind = 'tool'
  where user_id = '1538641284711849984' and kind = 'chat'
    and (content like '-# %' or content like 'Tool used:%');
