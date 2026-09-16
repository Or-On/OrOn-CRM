from oron_agent.conversation_harness import ConversationHarness


def test_acceptance_conversation_keeps_one_history_and_switches_language():
    harness = ConversationHarness(system_prompt="Natural support representative")

    first = harness.simulate_user_turn(
        "Hello, how are you?",
        provider_language="en",
        assistant_fixture="I'm doing well, thanks. How are you?",
    )
    second = harness.simulate_user_turn(
        "I'm good, thanks.",
        provider_language="en",
        assistant_fixture="Glad to hear it.",
    )
    third = harness.simulate_user_turn(
        "Actually my printer keeps disconnecting every few minutes.",
        provider_language="en",
        assistant_fixture="Does it disconnect from Wi-Fi, or only show as offline?",
    )
    fourth = harness.simulate_user_turn(
        "Wait, it's only happening on Wi-Fi.",
        provider_language="en",
        assistant_fixture="Got it. Does the printer reconnect by itself?",
    )
    fifth = harness.simulate_user_turn(
        "בעצם בוא נמשיך בעברית.",
        provider_language="he",
        assistant_fixture="בטח. האם המדפסת מתחברת מחדש לבד?",
    )

    assert [first.turn_id, second.turn_id, third.turn_id, fourth.turn_id, fifth.turn_id] == [
        "turn-1",
        "turn-2",
        "turn-3",
        "turn-4",
        "turn-5",
    ]
    assert first.assistant_response == "I'm doing well, thanks. How are you?"
    assert fifth.tts_language == "he"
    assert fifth.llm_calls == 5 and fifth.tts_streams == 5
    user_messages = [message["content"] for message in fifth.messages if message["role"] == "user"]
    assert user_messages == [
        "Hello, how are you?",
        "I'm good, thanks.",
        "Actually my printer keeps disconnecting every few minutes.",
        "Wait, it's only happening on Wi-Fi.",
        "בעצם בוא נמשיך בעברית.",
    ]


def test_mixed_language_turn_is_one_user_message_and_one_llm_call():
    harness = ConversationHarness(default_language="he")
    snapshot = harness.simulate_user_turn(
        "יש לי problem with the printer and הוא כל הזמן מתנתק.",
        provider_language="he",
    )
    users = [message for message in snapshot.messages if message["role"] == "user"]
    assert users == [
        {
            "role": "user",
            "content": "יש לי problem with the printer and הוא כל הזמן מתנתק.",
        }
    ]
    assert snapshot.llm_calls == 1 and snapshot.tts_streams == 0


def test_explicit_requested_response_language_selects_tts_without_changing_caller_metadata():
    harness = ConversationHarness(default_language="en")
    snapshot = harness.simulate_user_turn(
        "Say that in French.",
        provider_language="en",
        assistant_fixture="<lang:fr> Bien sûr. Voici l'explication en français.",
    )

    assert snapshot.tts_language == "fr"
    assert snapshot.assistant_response == "Bien sûr. Voici l'explication en français."
    assert "<lang:" not in snapshot.assistant_response
