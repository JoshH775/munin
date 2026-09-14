-- Nothing set `kind` on insert, so every breadcrumb since the column landed defaulted to 'chat'.
update messages set kind = 'tool'
  where kind = 'chat' and user_id = '1538641284711849984' and content like '-# %';
