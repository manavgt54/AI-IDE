"""
module2.py

This module provides modular functionality, including a greeting function,
a simple calculation function, and a basic data processing class.
It demonstrates how to structure a Python module with reusable components.
"""

def greet(name: str) -> str:
    """
    Returns a personalized greeting message.

    Args:
        name (str): The name of the person to greet.

    Returns:
        str: A greeting string.
    """
    if not isinstance(name, str) or not name:
        raise ValueError("Name must be a non-empty string.")
    return f"Hello, {name}! Welcome to Module 2."

def calculate_rectangle_area(length: float, width: float) -> float:
    """
    Calculates the area of a rectangle.

    Args:
        length (float): The length of the rectangle.
        width (float): The width of the rectangle.

    Returns:
        float: The calculated area.

    Raises:
        ValueError: If length or width are non-positive.
    """
    if not isinstance(length, (int, float)) or length <= 0:
        raise ValueError("Length must be a positive number.")
    if not isinstance(width, (int, float)) or width <= 0:
        raise ValueError("Width must be a positive number.")
    return length * width

class DataProcessor:
    """
    A simple class to demonstrate data processing capabilities.
    It can store a list of items and perform basic operations on them.
    """
    def __init__(self, initial_data: list = None):
        """
        Initializes the DataProcessor with an optional list of initial data.

        Args:
            initial_data (list, optional): A list of items to start with.
                                           Defaults to an empty list.
        """
        self._data = list(initial_data) if initial_data is not None else []

    def add_item(self, item):
        """
        Adds an item to the internal data list.

        Args:
            item: The item to be added.
        """
        self._data.append(item)
        print(f"Added: {item}")

    def get_data(self) -> list:
        """
        Returns a copy of the internal data list.

        Returns:
            list: A list of the stored items.
        """
        return self._data[:] # Return a copy to prevent external modification

    def process_data(self):
        """
        A placeholder method to simulate data processing.
        In a real scenario, this would contain actual processing logic.
        """
        if not self._data:
            print("No data to process.")
            return

        print(f"Processing {len(self._data)} items...")
        # Example processing: just printing for demonstration
        for i, item in enumerate(self._data):
            print(f"  Item {i+1}: {item}")
        print("Data processing complete.")


if __name__ == "__main__":
    print("--- Demonstrating module2.py functionality ---")

    # Demonstrate greet function
    print("\n1. Greeting Function:")
    try:
        print(greet("Alice"))
        print(greet("Bob"))
        # print(greet("")) # Uncomment to test ValueError
    except ValueError as e:
        print(f"Error: {e}")

    # Demonstrate calculate_rectangle_area function
    print("\n2. Rectangle Area Calculation:")
    try:
        area1 = calculate_rectangle_area(10, 5)
        print(f"Area of rectangle (10x5): {area1}")
        area2 = calculate_rectangle_area(7.5, 3.2)
        print(f"Area of rectangle (7.5x3.2): {area2}")
        # print(calculate_rectangle_area(-2, 5)) # Uncomment to test ValueError
    except ValueError as e:
        print(f"Error: {e}")

    # Demonstrate DataProcessor class
    print("\n3. DataProcessor Class:")
    processor = DataProcessor(["apple", "banana"])
    processor.add_item("cherry")
    processor.add_item(123)

    print(f"Current data in processor: {processor.get_data()}")
    processor.process_data()

    print("\n--- End of demonstration ---")
