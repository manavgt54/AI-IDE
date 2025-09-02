# app_app.py
# Basic Application
# Created automatically by the IDE

class BasicApp:
    def __init__(self):
        self.name = "app_app.py"
        self.version = "1.0.0"
    
    def start(self):
        print(f"Starting {self.name} v{self.version}")
        print("This is a basic application template.")
        print("You can customize this code for your specific needs.")
    
    def run(self):
        self.start()
        print("\nApplication is running...")
        print("Press Ctrl+C to exit")
        
        try:
            while True:
                user_input = input("\nEnter command (or 'quit' to exit): ").strip()
                if user_input.lower() == 'quit':
                    print("Goodbye!")
                    break
                else:
                    print(f"You entered: {user_input}")
        except KeyboardInterrupt:
            print("\nGoodbye!")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    app = BasicApp()
    app.run()
