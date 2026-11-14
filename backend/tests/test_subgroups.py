import pytest

from app.schedule.participants import Participant, has_participant_overlap


@pytest.mark.parametrize(
    "left,right,expected",
    [
        (Participant(1), Participant(1), True),
        (Participant(1), Participant(1, 10), True),
        (Participant(1, 10), Participant(1, 10), True),
        (Participant(1, 10), Participant(1, 11), False),
        (Participant(1), Participant(2), False),
        (Participant(1, 10), Participant(2, 10), False),
    ],
)
def test_formal_participant_overlap_is_symmetric_and_conservative(left, right, expected):
    assert has_participant_overlap(left, right) is expected
    assert has_participant_overlap(right, left) is expected
