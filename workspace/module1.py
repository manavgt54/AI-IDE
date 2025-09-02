"""
module1.py

This module provides basic modular functionality as an example.
It includes functions for common operations like greeting and arithmetic.
"""

# --- Constants ---
DEFAULT_GREETING_PREFIX = "Hello"
VERSION = "1.0.0"

# --- Functions ---

def greet(name: str, prefix: str = DEFAULT_GREETING_PREFIX) -> str:
    """
    Generates a personalized greeting message.

    Args:
        name (str): The name of the person to greet.
        prefix (str, optional): The greeting prefix (e.g., "Hello", "Hi").
                                Defaults to DEFAULT_GREETING_PREFIX.

    Returns:
        str: The complete greeting message.
    """
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Name must be a non-empty string.")
    if not isinstance(prefix, str) or not prefix.strip():
        raise ValueError("Prefix must be a non-empty string.")
    return f"{prefix}, {name}!"

def add(a: float, b: float) -> float:
    """
    Adds two numbers together.

    Args:
        a (float): The first number.
        b (float): The second number.

    Returns:
        float: The sum of a and b.
    """
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Both inputs must be numbers (int or float).")
    return a + b

def subtract(a: float, b: float) -> float:
    """
    Subtracts the second number from the first.

    Args:
        a (float): The first number (minuend).
        b (float): The second number (subtrahend).

    Returns:
        float: The difference between a and b.
    """
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Both inputs must be numbers (int or float).")
    return a - b

# --- Example Usage / Module Test ---
if __name__ == "__main__":
    print(f"--- Running module1.py as a script (Version: {VERSION}) ---")

    # Demonstrate greet function
    print("\n--- Greeting Examples ---")
    try:
        print(greet("Alice"))
        print(greet("Bob", prefix="Hi"))
        print(greet("Charlie", prefix="Good morning"))
        # print(greet("")) # This would raise a ValueError
    except ValueError as e:
        print(f"Error: {e}")

    # Demonstrate add function
    print("\n--- Addition Examples ---")
    try:
        print(f"5 + 3 = {add(5, 3)}")
        print(f"10.5 + 2.3 = {add(10.5, 2.3)}")
        print(f"0 + 0 = {add(0, 0)}")
        # print(f"'a' + 2 = {add('a', 2)}") # This would raise a TypeError
    except TypeError as e:
        print(f"Error: {e}")

    # Demonstrate subtract function
    print("\n--- Subtraction Examples ---")
    try:
        print(f"10 - 4 = {subtract(10, 4)}")
        print(f"7.8 - 2.1 = {subtract(7.8, 2.1)}")
        print(f"5 - 10 = {subtract(5, 10)}")
    except TypeError as e:
        print(f"Error: {e}")

    print("\n--- Module functionality demonstrated ---")
