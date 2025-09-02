# models.py
"""
Data models for the application, including data structures and validation.

This module defines Pydantic models to ensure data integrity and provide
a clear structure for various entities within the application.
"""

from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field, EmailStr, HttpUrl


class UserModel(BaseModel):
    """
    Represents a user in the system.

    Attributes:
        id (int): Unique identifier for the user. Must be a positive integer.
        username (str): The user's unique username. Must be between 3 and 50 characters.
        email (EmailStr): The user's email address. Must be a valid email format.
        first_name (Optional[str]): The user's first name. Optional, max 50 characters.
        last_name (Optional[str]): The user's last name. Optional, max 50 characters.
        is_active (bool): Flag indicating if the user account is active. Defaults to True.
        created_at (datetime): Timestamp when the user account was created.
                               Defaults to the current UTC time.
        updated_at (Optional[datetime]): Timestamp when the user account was last updated.
                                         Optional, defaults to None.
    """
    id: int = Field(..., gt=0, description="Unique identifier for the user")
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        pattern=r"^[a-zA-Z0-9_-]+$",
        description="Unique username for the user (alphanumeric, hyphens, underscores)"
    )
    email: EmailStr = Field(..., description="Valid email address of the user")
    first_name: Optional[str] = Field(None, max_length=50, description="User's first name")
    last_name: Optional[str] = Field(None, max_length=50, description="User's last name")
    is_active: bool = Field(True, description="Indicates if the user account is active")
    created_at: datetime = Field(default_factory=datetime.utcnow, description="Timestamp of user creation (UTC)")
    updated_at: Optional[datetime] = Field(None, description="Timestamp of last user update (UTC)")

    class Config:
        """Pydantic model configuration."""
        json_schema_extra = {
            "example": {
                "id": 123,
                "username": "johndoe",
                "email": "john.doe@example.com",
                "first_name": "John",
                "last_name": "Doe",
                "is_active": True,
                "created_at": "2023-10-27T10:00:00.000Z",
                "updated_at": None
            }
        }


class ProductModel(BaseModel):
    """
    Represents a product available in the system.

    Attributes:
        id (str): Unique identifier for the product (e.g., SKU).
        name (str): The name of the product.
        description (Optional[str]): A detailed description of the product.
        price (float): The price of the product. Must be positive.
        currency (str): The currency code (e.g., "USD", "EUR"). Defaults to "USD".
        stock_quantity (int): The number of items in stock. Must be non-negative.
        is_available (bool): Flag indicating if the product is currently available for purchase.
        image_urls (List[HttpUrl]): A list of URLs to product images.
    """
    id: str = Field(..., min_length=1, max_length=100, description="Unique product identifier (SKU)")
    name: str = Field(..., min_length=1, max_length=200, description="Name of the product")
    description: Optional[str] = Field(None, max_length=1000, description="Detailed description of the product")
    price: float = Field(..., gt=0, description="Price of the product, must be positive")
    currency: str = Field("USD", pattern=r"^[A-Z]{3}$", description="Currency code (e.g., USD, EUR)")
    stock_quantity: int = Field(..., ge=0, description="Number of items currently in stock")
    is_available: bool = Field(True, description="Availability status of the product")
    image_urls: List[HttpUrl] = Field([], description="List of URLs to product images")

    class Config:
        """Pydantic model configuration."""
        json_schema_extra = {
            "example": {
                "id": "PROD-XYZ-789",
                "name": "Wireless Bluetooth Headphones",
                "description": "High-fidelity wireless headphones with noise cancellation.",
                "price": 99.99,
                "currency": "USD",
                "stock_quantity": 50,
                "is_available": True,
                "image_urls": [
                    "https://example.com/images/headphones_front.jpg",
                    "https://example.com/images/headphones_side.jpg"
                ]
            }
        }


if __name__ == "__main__":
    print("--- Demonstrating UserModel ---")
    try:
        # Valid user data
        user_data = {
            "id": 1,
            "username": "test_user",
            "email": "test@example.com",
            "first_name": "Test",
            "last_name": "User"
        }
        user = UserModel(**user_data)
        print(f"Successfully created user: {user.model_dump_json(indent=2)}")

        # Invalid user data (missing required field)
        invalid_user_data_1 = {
            "id": 2,
            "username": "another_user",
            # "email": "missing@example.com" # Email is missing
        }
        try:
            UserModel(**invalid_user_data_1)
        except Exception as e:
            print(f"\nFailed to create user (missing email): {e}")

        # Invalid user data (invalid email format)
        invalid_user_data_2 = {
            "id": 3,
            "username": "bad_email_user",
            "email": "invalid-email",
        }
        try:
            UserModel(**invalid_user_data_2)
        except Exception as e:
            print(f"\nFailed to create user (invalid email): {e}")

        # Invalid user data (username too short)
        invalid_user_data_3 = {
            "id": 4,
            "username": "ab",
            "email": "short@example.com",
        }
        try:
            UserModel(**invalid_user_data_3)
        except Exception as e:
            print(f"\nFailed to create user (username too short): {e}")

    except Exception as e:
        print(f"An unexpected error occurred during UserModel demonstration: {e}")


    print("\n--- Demonstrating ProductModel ---")
    try:
        # Valid product data
        product_data = {
            "id": "SKU-001",
            "name": "Laptop Pro",
            "description": "High-performance laptop for professionals.",
            "price": 1200.50,
            "stock_quantity": 10,
            "image_urls": [
                "https://example.com/laptop1.jpg",
                "https://example.com/laptop2.jpg"
            ]
        }
        product = ProductModel(**product_data)
        print(f"Successfully created product: {product.model_dump_json(indent=2)}")

        # Invalid product data (negative price)
        invalid_product_data_1 = {
            "id": "SKU-002",
            "name": "Cheap Item",
            "price": -5.00,
            "stock_quantity": 100,
        }
        try:
            ProductModel(**invalid_product_data_1)
        except Exception as e:
            print(f"\nFailed to create product (negative price): {e}")

        # Invalid product data (invalid image URL)
        invalid_product_data_2 = {
            "id": "SKU-003",
            "name": "Broken Image Product",
            "price": 10.00,
            "stock_quantity": 5,
            "image_urls": ["not-a-valid-url"]
        }
        try:
            ProductModel(**invalid_product_data_2)
        except Exception as e:
            print(f"\nFailed to create product (invalid image URL): {e}")

    except Exception as e:
        print(f"An unexpected error occurred during ProductModel demonstration: {e}")
