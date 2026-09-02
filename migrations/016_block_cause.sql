-- What kind of wall a blocked scrape actually hit.
--
-- error_kind 'blocked' collapses four different problems with four different
-- remedies into one word: a rate limit we should fix by slowing down, a bot
-- challenge politeness cannot clear, a plain refusal that is usually just our
-- user agent, and a legal block no tool answers. Recording the cause lets the
-- health card say which competitors are worth another attempt and which are
-- genuinely closed to us.
ALTER TABLE scrape_run_items ADD COLUMN IF NOT EXISTS block_cause TEXT;
