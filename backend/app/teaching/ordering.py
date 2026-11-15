"""Locale-independent Russian alphabet keys shared by SQL and cursor comparisons.

translate maps both cases to consecutive Unicode ranks: Е < Ё < Ж. Built-in
C collation compares the resulting UTF-8 strings in the same order as Python.
Other characters retain their code points; Latin case is folded explicitly too.
No ICU installation, database locale, extension or migration is required.
"""

from string import ascii_lowercase, ascii_uppercase

from sqlalchemy import func, literal

STUDENT_KEY_PREFIX = "ru-v1:"
RUSSIAN_ALPHABET = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
RUSSIAN_RANKS = "".join(chr(0x430 + index) for index in range(len(RUSSIAN_ALPHABET)))
NAME_KEY_SOURCE = RUSSIAN_ALPHABET.upper() + RUSSIAN_ALPHABET + ascii_uppercase
NAME_KEY_TARGET = RUSSIAN_RANKS * 2 + ascii_lowercase


def get_student_name_key(full_name):
    return (
        (literal(STUDENT_KEY_PREFIX) + func.translate(full_name, NAME_KEY_SOURCE, NAME_KEY_TARGET))
        .collate("C")
        .label("student_sort_key")
    )
