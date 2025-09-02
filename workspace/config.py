import os

class Config:
    """
    Base configuration class.
    Provides default settings and reads environment variables.
    """
    DEBUG = os.getenv('FLASK_DEBUG', 'False').lower() in ('true', '1', 't')
    TESTING = False
    SECRET_KEY = os.getenv('SECRET_KEY', 'a_very_secret_default_key_if_not_set')
    DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///app.db')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
    # Example for an API key
    API_KEY = os.getenv('API_KEY', None)

    @staticmethod
    def init_app(app):
        """
        Optional: Initialize app-specific configurations if using a framework like Flask.
        """
        pass

class DevelopmentConfig(Config):
    """
    Development specific configuration.
    """
    DEBUG = True
    DATABASE_URL = os.getenv('DEV_DATABASE_URL', 'sqlite:///dev.db')
    LOG_LEVEL = os.getenv('DEV_LOG_LEVEL', 'DEBUG').upper()

class TestingConfig(Config):
    """
    Testing specific configuration.
    """
    TESTING = True
    DEBUG = True # Often true for testing to see detailed errors
    DATABASE_URL = os.getenv('TEST_DATABASE_URL', 'sqlite:///:memory:') # In-memory database for tests
    LOG_LEVEL = os.getenv('TEST_LOG_LEVEL', 'DEBUG').upper()
    SECRET_KEY = 'a_test_secret_key' # Use a predictable key for testing

class ProductionConfig(Config):
    """
    Production specific configuration.
    """
    DEBUG = False
    DATABASE_URL = os.getenv('PROD_DATABASE_URL') # Should be set in production environment
    LOG_LEVEL = os.getenv('PROD_LOG_LEVEL', 'WARNING').upper()
    # Ensure SECRET_KEY is always set in production environment
    if Config.SECRET_KEY == 'a_very_secret_default_key_if_not_set':
        raise ValueError("SECRET_KEY must be set in the production environment.")
    # Example: Disable certain features in production if needed
    FEATURE_X_ENABLED = os.getenv('FEATURE_X_ENABLED', 'False').lower() in ('true', '1', 't')


# Dictionary to easily select the configuration based on an environment variable
config_by_name = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig # Fallback to development if env not set
}

def get_config():
    """
    Returns the appropriate configuration class based on the 'FLASK_ENV' or 'APP_ENV' environment variable.
    Defaults to DevelopmentConfig if not set.
    """
    env_name = os.getenv('FLASK_ENV', os.getenv('APP_ENV', 'development')).lower()
    return config_by_name.get(env_name, config_by_name['default'])

# Example of how to use it:
# current_config = get_config()
# print(f"Current Environment: {os.getenv('FLASK_ENV', 'development')}")
# print(f"Debug Mode: {current_config.DEBUG}")
# print(f"Database URL: {current_config.DATABASE_URL}")
# print(f"Log Level: {current_config.LOG_LEVEL}")
# print(f"Secret Key: {current_config.SECRET_KEY}") # Be careful not to print this in production logs!

# You can also directly access the chosen config class:
# if __name__ == '__main__':
#     # To test different environments:
#     # export FLASK_ENV=production
#     # python config.py
#     #
#     # export FLASK_ENV=testing
#     # python config.py
#     #
#     # export FLASK_ENV=development
#     # python config.py
#     #
#     # python config.py (will default to development)

#     current_config = get_config()
#     print(f"\n--- Configuration for '{os.getenv('FLASK_ENV', 'development')}' ---")
#     print(f"DEBUG: {current_config.DEBUG}")
#     print(f"TESTING: {current_config.TESTING}")
#     print(f"DATABASE_URL: {current_config.DATABASE_URL}")
#     print(f"LOG_LEVEL: {current_config.LOG_LEVEL}")
#     print(f"SECRET_KEY (first 10 chars): {current_config.SECRET_KEY[:10]}...")
#     if hasattr(current_config, 'FEATURE_X_ENABLED'):
#         print(f"FEATURE_X_ENABLED: {current_config.FEATURE_X_ENABLED}")
