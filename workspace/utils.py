# utils.py

"""
A collection of utility functions for common operations and helper tasks.
"""

import os
import re
import datetime

def log_message(message: str, level: str = "INFO"):
    """
    Logs a message with a timestamp and a specified level.

    Args:
        message (str): The message to log.
        level (str): The logging level (e.g., "INFO", "WARNING", "ERROR").
                     Defaults to "INFO".
    """
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level.upper()}] {message}")

def read_text_file(file_path: str, encoding: str = "utf-8") -> str | None:
    """
    Reads the entire content of a text file.

    Args:
        file_path (str): The path to the file to read.
        encoding (str): The character encoding of the file. Defaults to "utf-8".

    Returns:
        str | None: The content of the file as a string, or None if an error occurs.
    """
    if not os.path.exists(file_path):
        log_message(f"File not found: {file_path}", level="ERROR")
        return None
    try:
        with open(file_path, 'r', encoding=encoding) as f:
            content = f.read()
        log_message(f"Successfully read file: {file_path}")
        return content
    except IOError as e:
        log_message(f"Error reading file {file_path}: {e}", level="ERROR")
        return None
    except Exception as e:
        log_message(f"An unexpected error occurred while reading {file_path}: {e}", level="ERROR")
        return None

def write_text_file(file_path: str, content: str, encoding: str = "utf-8", overwrite: bool = True) -> bool:
    """
    Writes content to a text file.

    Args:
        file_path (str): The path to the file to write.
        content (str): The string content to write to the file.
        encoding (str): The character encoding to use. Defaults to "utf-8".
        overwrite (bool): If True, overwrites the file if it exists. If False,
                          appends to the file. Defaults to True.

    Returns:
        bool: True if the write operation was successful, False otherwise.
    """
    mode = 'w' if overwrite else 'a'
    try:
        with open(file_path, mode, encoding=encoding) as f:
            f.write(content)
        log_message(f"Successfully wrote content to file: {file_path} (mode: {'overwrite' if overwrite else 'append'})")
        return True
    except IOError as e:
        log_message(f"Error writing to file {file_path}: {e}", level="ERROR")
        return False
    except Exception as e:
        log_message(f"An unexpected error occurred while writing to {file_path}: {e}", level="ERROR")
        return False

def slugify(text: str) -> str:
    """
    Converts a string into a URL-friendly slug.

    Args:
        text (str): The input string.

    Returns:
        str: The slugified string.
    """
    text = str(text).lower()
    text = re.sub(r'[^\w\s-]', '', text)  # Remove all non-word chars (except spaces and hyphens)
    text = re.sub(r'[\s_-]+', '-', text)  # Replace spaces and multiple hyphens with a single hyphen
    text = re.sub(r'^-+|-+$', '', text)   # Remove leading/trailing hyphens
    log_message(f"Slugified '{text}'")
    return text

def is_valid_email(email: str) -> bool:
    """
    Checks if a string is a valid email address using a simple regex pattern.

    Note: This is a basic validation and might not cover all edge cases
    of RFC-compliant email addresses.

    Args:
        email (str): The email string to validate.

    Returns:
        bool: True if the email is valid, False otherwise.
    """
    # A more robust regex might be needed for production, but this covers most common cases.
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    is_valid = re.match(pattern, email) is not None
    log_message(f"Email '{email}' is {'valid' if is_valid else 'invalid'}")
    return is_valid

# Example usage (for testing purposes, typically removed or put in a __main__ block)
if __name__ == "__main__":
    log_message("Starting utility function tests.")

    # Test log_message
    log_message("This is an informational message.")
    log_message("This is a warning!", level="WARNING")
    log_message("This is an error!", level="ERROR")

    # Test write_text_file and read_text_file
    test_file = "test_utils.txt"
    test_content = "Hello, this is a test.\nLine 2.\n"
    if write_text_file(test_file, test_content):
        print(f"Content written to {test_file}")
        read_content = read_text_file(test_file)
        if read_content:
            print(f"Content read from {test_file}:\n{read_content}")
            assert read_content == test_content
            log_message("Read/write test passed.")
        else:
            log_message("Read/write test failed: Could not read content.", level="ERROR")
    else:
        log_message("Read/write test failed: Could not write content.", level="ERROR")

    # Test append mode
    append_content = "Appended line."
    if write_text_file(test_file, append_content, overwrite=False):
        read_content_appended = read_text_file(test_file)
        expected_content = test_content + append_content
        if read_content_appended:
            print(f"Content after append:\n{read_content_appended}")
            assert read_content_appended == expected_content
            log_message("Append test passed.")
        else:
            log_message("Append test failed: Could not read appended content.", level="ERROR")
    else:
        log_message("Append test failed: Could not append content.", level="ERROR")

    # Test non-existent file read
    log_message("Attempting to read non-existent file:")
    read_text_file("non_existent_file.txt")

    # Test slugify
    print(f"Slug for 'My Awesome Article Title!' is: {slugify('My Awesome Article Title!')}")
    assert slugify('My Awesome Article Title!') == 'my-awesome-article-title'
    print(f"Slug for 'Another-one with spaces & symbols' is: {slugify('Another-one with spaces & symbols')}")
    assert slugify('Another-one with spaces & symbols') == 'another-one-with-spaces-symbols'
    print(f"Slug for '  Leading and Trailing Spaces  ' is: {slugify('  Leading and Trailing Spaces  ')}")
    assert slugify('  Leading and Trailing Spaces  ') == 'leading-and-trailing-spaces'
    log_message("Slugify tests passed.")

    # Test is_valid_email
    print(f"'test@example.com' is valid: {is_valid_email('test@example.com')}")
    assert is_valid_email('test@example.com') is True
    print(f"'invalid-email' is valid: {is_valid_email('invalid-email')}")
    assert is_valid_email('invalid-email') is False
    print(f"'user.name+tag@sub.domain.co.uk' is valid: {is_valid_email('user.name+tag@sub.domain.co.uk')}")
    assert is_valid_email('user.name+tag@sub.domain.co.uk') is True
    log_message("Email validation tests passed.")

    # Clean up test file
    if os.path.exists(test_file):
        os.remove(test_file)
        log_message(f"Cleaned up test file: {test_file}")

    log_message("All utility function tests completed.")
